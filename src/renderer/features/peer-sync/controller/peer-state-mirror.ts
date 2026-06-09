/**
 * Adapter that turns an incoming MQTT PeerState frame into a partial
 * RemoteMirrored update and pushes it into the existing remote-target
 * store via the optimistic-hold-aware `applyMirrorFromServer` action.
 *
 * The store is the single source of truth — sessions-sink (Jellyfin lane)
 * and this adapter (MQTT lane) are interchangeable inputs. Whichever lane
 * is alive feeds the store; the per-field optimistic holds installed by
 * the dispatcher protect us from a stale frame from the *other* lane
 * arriving milliseconds later.
 */
import type { RemoteMirrorInput } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import {
    getFreshPeerIds,
    getPeerIdForJellyfinDeviceId,
    pickTransport,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { peekDiagnostics } from '/@/renderer/features/peer-sync/diagnostics/diagnostics-store';
import { peerToJellyfinRepeat } from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerAddress } from '/@/renderer/features/peer-sync/protocol/topics';
import { PeerState } from '/@/renderer/features/peer-sync/types';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { LibraryItem, ServerType, Song } from '/@/shared/types/domain-types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);
const warn = (...args: unknown[]) => console.warn('[peer-sync]', ...args);

const perfDebug = (): boolean => {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem('perf.connect') === '1';
    } catch {
        return false;
    }
};

const perfMark = (label: string, payload: Record<string, unknown>): void => {
    if (!perfDebug()) return;
    console.info('[perf.connect]', label, { ts: performance.now(), ...payload });
};

/**
 * Convert a PeerState wire frame into a Partial<RemoteMirrored> suitable
 * for `applyMirrorFromServer`. The Song shape requires a lot of fields we
 * don't have over the wire — we synthesize a minimal stub good enough for
 * the player bar and full-screen now-playing UI to render.
 *
 * Optional v1+ fields (`mut`, `qIdx`) are passed through when present and
 * omitted (rather than defaulted) when absent so a publisher that doesn't
 * carry them yet can't silently flip the controller's mirrored mute state.
 *
 * `oneWayOffsetMs` (A6) shifts the interpolation base forward by the measured
 * one-way latency so the mirrored playhead doesn't trail the target by the
 * broker+network delay. It is computed from RTT on the LOCAL clock (skew-free)
 * by the caller and is only non-zero while playing.
 */
// ---------------------------------------------------------------------------
// Controller-side hydration of wire stubs.
//
// The wire deliberately stays compact: `track.art` is whatever URL the TARGET
// uses (its session token / device binding — the controller often can't load
// it), and the queue is bare `qIds`. The controller is on the same Jellyfin
// server as the target (the room is keyed by the JF user), so it derives art
// from `track.id` through its OWN connection, and hydrates `qIds` into full
// Song objects through its own API — covers + readable upcoming tracks.

// Album art for a track id via the controller's own server/auth. The image
// helper lives in the item-image component module — statically importing it
// here would drag the whole API surface into every peer-sync unit test (the
// receiver lazy-imports remote-target-api for the same reason), so it loads
// on first use; until then we return null and the caller falls back to the
// wire-supplied art URL (one frame at most).
type GetItemImageUrlFn = (args: { id: string; itemType: LibraryItem }) => string | undefined;
let getItemImageUrlRef: GetItemImageUrlFn | null = null;
let getItemImageUrlLoading = false;

const ensureImageHelperLoaded = (): void => {
    if (getItemImageUrlRef || getItemImageUrlLoading) return;
    getItemImageUrlLoading = true;
    void import('/@/renderer/components/item-image/item-image')
        .then((mod) => {
            getItemImageUrlRef = mod.getItemImageUrl as GetItemImageUrlFn;
        })
        .catch(() => {
            getItemImageUrlLoading = false;
        });
};

const deriveControllerArt = (trackId: string | undefined): null | string => {
    if (!trackId) return null;
    ensureImageHelperLoaded();
    if (!getItemImageUrlRef) return null;
    try {
        return getItemImageUrlRef({ id: trackId, itemType: LibraryItem.SONG }) ?? null;
    } catch {
        return null;
    }
};

// Hydrated Song objects keyed by id, shared by the queue builder and the
// now-playing stub so later state ticks keep full metadata instead of
// regressing to id stubs. Bounded; oldest entries evicted first.
const HYDRATED_CACHE_CAP = 500;
const hydratedSongs = new Map<string, Song>();

const cacheHydratedSong = (song: Song): void => {
    if (!song?.id) return;
    hydratedSongs.delete(song.id);
    hydratedSongs.set(song.id, song);
    while (hydratedSongs.size > HYDRATED_CACHE_CAP) {
        const oldest = hydratedSongs.keys().next().value;
        if (oldest === undefined) break;
        hydratedSongs.delete(oldest);
    }
};

let lastHydrateKey = '';
let lastHydrateAttemptAt = 0;
let hydrateInFlight = false;
const HYDRATE_RETRY_MS = 30_000;

/** Test-only: clear hydration state between tests. */
export const __resetQueueHydration = (): void => {
    hydratedSongs.clear();
    lastHydrateKey = '';
    lastHydrateAttemptAt = 0;
    hydrateInFlight = false;
};

/**
 * Hydrate the mirrored queue's bare ids into full Song objects through the
 * controller's own Jellyfin connection, then patch the store — provided the
 * mirrored queue still shows the same ids (a newer frame may have replaced
 * it while the request was in flight). Deduped per id-set; failed attempts
 * retry after a cooldown rather than on every 2Hz state tick.
 */
export const ensureQueueHydrated = async (qIds: string[], qIdx: number): Promise<void> => {
    if (qIds.length === 0) return;
    const key = qIds.join('|');
    const missing = qIds.filter((id) => !hydratedSongs.has(id));

    if (hydrateInFlight) return;
    if (missing.length === 0 && key === lastHydrateKey) return;
    if (
        missing.length > 0 &&
        key === lastHydrateKey &&
        Date.now() - lastHydrateAttemptAt < HYDRATE_RETRY_MS
    ) {
        return;
    }

    lastHydrateKey = key;
    lastHydrateAttemptAt = Date.now();

    if (missing.length > 0) {
        const server = useAuthStore.getState().currentServer;
        if (!server || server.type !== ServerType.JELLYFIN || !server.userId) return;
        hydrateInFlight = true;
        try {
            // Lazy import (mirrors peer-receiver): keeps the JF API surface
            // out of unit tests that only exercise the synchronous mapping.
            const mod =
                await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
            const songs = (await mod.remoteTargetApi.hydrateSongs({
                itemIds: missing,
                server: server as never,
            })) as Song[];
            songs.forEach(cacheHydratedSong);
            log('queue hydrated', { hydrated: songs.length, requested: missing.length });
        } catch (err) {
            warn('queue hydrate failed', { error: (err as Error)?.message });
            return;
        } finally {
            hydrateInFlight = false;
        }
    }

    // Patch only when the mirror still shows this exact queue.
    const { actions, mirrored } = useRemoteTargetStore.getState();
    const current = mirrored?.queue;
    if (!Array.isArray(current) || current.length !== qIds.length) return;
    if (!current.every((s: Song, i: number) => s?.id === qIds[i])) return;

    actions.applyMirrorFromServer({
        queue: qIds.map((id, i) => hydratedSongs.get(id) ?? current[i]),
        queueIndex: qIdx >= 0 && qIdx < qIds.length ? qIdx : -1,
    });
};

const idStubSong = (id: string): Song =>
    ({
        album: '',
        albumArtists: [],
        artists: [],
        container: null,
        duration: 0,
        id,
        imageUrl: null,
        itemType: 'song',
        name: '',
    }) as unknown as Song;

export const peerStateToMirrored = (state: PeerState, oneWayOffsetMs = 0): RemoteMirrorInput => {
    // Prefer the hydrated full Song (controller-side fetch by id) when we
    // already have it — full metadata + a cover the controller can load.
    const hydratedNowPlaying = state.track ? hydratedSongs.get(state.track.id) : undefined;
    const stubSong: null | Song =
        hydratedNowPlaying ??
        (state.track
            ? ({
                  album: state.track.album ?? '',
                  albumArtists: state.track.artist
                      ? [{ id: '', imageUrl: null, name: state.track.artist }]
                      : [],
                  artists: state.track.artist
                      ? [{ id: '', imageUrl: null, name: state.track.artist }]
                      : [],
                  container: null,
                  duration: state.dur,
                  id: state.track.id,
                  // Art the CONTROLLER can actually load: derived from the
                  // track id via the controller's own server/auth. The wire
                  // `art` URL carries the TARGET's session token and is only
                  // kept as a fallback for cross-server edge cases.
                  imageUrl: deriveControllerArt(state.track.id) ?? state.track.art ?? null,
                  itemType: 'song',
                  name: state.track.title ?? '',
                  // Unknown server-specific fields default to nullish; the UI
                  // tolerates them. The shape is intentionally minimal — when
                  // we want richer metadata we can add it to the protocol.
              } as unknown as Song)
            : null);

    const out: RemoteMirrorInput = {
        nowPlayingItem: stubSong,
        playState: {
            // isMuted is optional on the wire — only include it when the
            // publisher actually supplied a value so the store's optimistic
            // hold for mute isn't clobbered by an absent field.
            ...(typeof state.mut === 'boolean' ? { isMuted: state.mut } : {}),
            isPaused: state.paused,
            // D3: rate is display-only — capture the target's reported speed so
            // a controller can surface it. Omitted when absent so it never
            // clobbers a prior value with undefined.
            ...(typeof state.rate === 'number' && Number.isFinite(state.rate)
                ? { playbackRate: state.rate }
                : {}),
            // A6: advance the base by the one-way latency while playing so the
            // playhead matches the target; paused frames need no correction.
            positionMs: state.paused ? state.pos : state.pos + oneWayOffsetMs,
            positionSampledAt: Date.now(),
            repeatMode: peerToJellyfinRepeat(state.rep),
            shuffle: state.shuf,
            volume: state.vol,
        },
    };
    // A4: keep `queue` and `queueIndex` internally consistent. Only publish a
    // queueIndex when we also publish the queue it indexes into. The wire
    // carries `qIds` (truncated, playback order); build a stub Song[] from it
    // — the full now-playing stub at the current slot, id-only stubs elsewhere
    // — so the queue panel mirrors the target instead of indexing a stale /
    // foreign (Jellyfin-lane) array. When `qIds` is absent we leave queueIndex
    // untouched rather than letting a bare `qIdx` point into the wrong array.
    if (Array.isArray(state.qIds) && state.qIds.length > 0) {
        const qIdx =
            typeof state.qIdx === 'number' && Number.isFinite(state.qIdx) ? state.qIdx : -1;
        // Hydrated songs (controller-side fetch by id) win over stubs, so a
        // 2Hz state tick never regresses an already-readable queue row back
        // to an empty id stub.
        out.queue = state.qIds.map(
            (id, i) =>
                hydratedSongs.get(id) ?? (i === qIdx && stubSong ? stubSong : idStubSong(id)),
        );
        out.queueIndex = qIdx >= 0 && qIdx < state.qIds.length ? qIdx : -1;
    }
    return out;
};

/**
 * Push an incoming MQTT state frame into the store. Gates, in order:
 *
 *   1. We must have a target picked. The mirror represents the *current*
 *      remote target, not arbitrary peers.
 *   2. MQTT must be the live lane for the sender (B4). A frame that arrives
 *      after the lane flipped back to Jellyfin — or any frame while sync is
 *      disabled — must not clobber the now-authoritative Jellyfin state.
 *   3. The sender must own the picked target — resolved through the transport
 *      selector's jellyfinDeviceId -> peerId bridge. A peer that isn't the one
 *      we picked has no business painting our mirror.
 *   4. If the bridge hasn't resolved the target's deviceId yet (older
 *      publisher, jellyfin-web session, presence not seen), accept the frame
 *      ONLY when exactly one peer is currently fresh AND it is the sender.
 *      Failing open here let any peer in the room paint the picked target's
 *      mirror; requiring a single unambiguous fresh peer preserves the v1
 *      migration path while closing that clobber hole.
 */
export const applyPeerStateToStore = (from: PeerAddress, state: PeerState): void => {
    const { actions, targetDeviceId } = useRemoteTargetStore.getState();
    if (!targetDeviceId) return;

    // Gate 2 (B4): only paint when MQTT owns the live lane for this peer.
    if (pickTransport(from.peerId) !== 'mqtt') {
        warn('dropped state; MQTT is not the live lane', { from: from.peerId });
        return;
    }

    const targetPeerId = getPeerIdForJellyfinDeviceId(targetDeviceId);
    if (targetPeerId) {
        // Gate 3: bridge resolved — the sender must be the picked target.
        if (from.peerId !== targetPeerId) {
            warn('dropped state from non-target peer', { from: from.peerId, targetPeerId });
            return;
        }
    } else {
        // Gate 4: bridge unresolved — accept only when the sender is the lone
        // fresh peer, so an unrelated peer can't hijack the mirror.
        const fresh = getFreshPeerIds();
        if (fresh.length !== 1 || fresh[0] !== from.peerId) {
            warn('dropped unbridged state; ambiguous target', { fresh, from: from.peerId });
            return;
        }
    }

    // A6: shift the interpolation base by the measured one-way latency (RTT/2,
    // computed on the local clock so it's skew-free). Clamped well under the
    // positionMs hold tolerance (1500ms) so it can never block a seek-hold
    // clear, and only applied while playing.
    const rttMs = peekDiagnostics().latency[from.peerId]?.rttMs;
    const oneWayOffsetMs =
        typeof rttMs === 'number' && Number.isFinite(rttMs)
            ? Math.min(1_000, Math.max(0, rttMs / 2))
            : 0;

    const mirrored = peerStateToMirrored(state, oneWayOffsetMs);
    log('apply state', {
        from: from.peerId,
        mut: state.mut,
        paused: state.paused,
        pos: state.pos,
        qIdx: state.qIdx,
        trackId: state.track?.id ?? null,
    });
    perfMark('mirror.apply.mqtt', {
        paused: state.paused,
        pos: state.pos,
        // Wire-side timestamp from sender so a perfDebug viewer can compute
        // end-to-end on its own clock when both peers have time sync.
        senderTs: state.ts,
        vol: state.vol,
    });
    actions.applyMirrorFromServer(mirrored);

    // Fire-and-forget: hydrate the bare queue ids through the controller's
    // own server so "upcoming tracks" shows real titles/covers. Deduped per
    // id-set inside; patches the store only if the queue is still current.
    if (Array.isArray(state.qIds) && state.qIds.length > 0) {
        const qIdx =
            typeof state.qIdx === 'number' && Number.isFinite(state.qIdx) ? state.qIdx : -1;
        void ensureQueueHydrated(state.qIds, qIdx);
    }
};
