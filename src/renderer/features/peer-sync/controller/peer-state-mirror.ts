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
import { peerToJellyfinRepeat } from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerState } from '/@/renderer/features/peer-sync/types';
import { Song } from '/@/shared/types/domain-types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

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
 */
export const peerStateToMirrored = (state: PeerState): RemoteMirrorInput => {
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
            positionMs: state.pos,
            positionSampledAt: Date.now(),
            repeatMode: peerToJellyfinRepeat(state.rep),
            shuffle: state.shuf,
            volume: state.vol,
        },
    };
    // queueIndex is signalled when present; we don't touch `queue` here —
    // the controller's UI consumes nowPlayingItem directly and a full
    // queue-hydrate would require the server credential, which the mirror
    // doesn't carry. Once we wire a credential through this seam, qIds can
    // drive a hydrate through `remoteTargetApi.hydrateSongs`.
    if (typeof state.qIdx === 'number' && Number.isFinite(state.qIdx)) {
        out.queueIndex = state.qIdx;
    }
    return out;
};

/**
 * Push an incoming MQTT state frame into the store. No-op when the user
 * has not yet picked a target (the mirror represents the *current* remote
 * target, not arbitrary peers).
 */
export const applyPeerStateToStore = (state: PeerState): void => {
    const { actions, targetDeviceId } = useRemoteTargetStore.getState();
    if (!targetDeviceId) return;
    const mirrored = peerStateToMirrored(state);
    log('apply state', {
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
