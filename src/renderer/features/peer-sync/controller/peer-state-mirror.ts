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
import { Song } from '/@/shared/types/domain-types';

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
    const stubSong: null | Song = state.track
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
              // The base image URL is the peer-supplied art URL; the local
              // player will request it through the normal <BaseImage> path.
              imageUrl: state.track.art ?? null,
              itemType: 'song',
              name: state.track.title ?? '',
              // Unknown server-specific fields default to nullish; the UI
              // tolerates them. The shape is intentionally minimal — when
              // we want richer metadata we can add it to the protocol.
          } as unknown as Song)
        : null;

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
        out.queue = state.qIds.map((id, i) => (i === qIdx && stubSong ? stubSong : idStubSong(id)));
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
};
