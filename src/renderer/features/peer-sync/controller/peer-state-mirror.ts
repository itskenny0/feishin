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
import type { RemoteMirrored } from '/@/renderer/features/jellyfin-remote-target/types';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { peerToJellyfinRepeat } from '/@/renderer/features/peer-sync/protocol/builders';
import { PeerState } from '/@/renderer/features/peer-sync/types';
import { Song } from '/@/shared/types/domain-types';

const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

/**
 * Convert a PeerState wire frame into a Partial<RemoteMirrored> suitable
 * for `applyMirrorFromServer`. The Song shape requires a lot of fields we
 * don't have over the wire — we synthesize a minimal stub good enough for
 * the player bar and full-screen now-playing UI to render.
 */
export const peerStateToMirrored = (state: PeerState): Partial<RemoteMirrored> => {
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

    return {
        nowPlayingItem: stubSong,
        playState: {
            isPaused: state.paused,
            positionMs: state.pos,
            positionSampledAt: Date.now(),
            repeatMode: peerToJellyfinRepeat(state.rep),
            shuffle: state.shuf,
            volume: state.vol,
        },
    };
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
        paused: state.paused,
        pos: state.pos,
        trackId: state.track?.id ?? null,
    });
    actions.applyMirrorFromServer(mirrored);
};
