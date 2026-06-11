import type { Song } from '/@/shared/types/domain-types';

export interface RemoteDevice {
    capabilities: string[]; // session.SupportedCommands
    client: string; // e.g. 'Jellyfin Media Player'
    deviceId: string; // session.DeviceId
    deviceName: string; // session.DeviceName (user-visible)
    isPaused: boolean;
    lastActivityIso: string; // session.LastActivityDate
    nowPlayingArtist: null | string;
    nowPlayingItemId: null | string;
    nowPlayingTitle: null | string;
    sessionId: string; // session.Id — what we POST to
    supportsMediaControl: boolean;
    supportsRemoteControl: boolean;
}

export interface RemoteMirrored {
    capabilities: string[];
    /**
     * Id of the track the target will ACTUALLY play next, as reported by the
     * target itself (resolved against its shuffle map + repeat mode). Only the
     * MQTT lane carries it (wire `nxt`); the Jellyfin lane leaves it null.
     * `null` when there is no next track or the lane doesn't report it — in
     * that case consumers fall back to `queue[queueIndex + 1]` (default order,
     * correct only when the target isn't shuffling). (BUG 1) */
    nextItemId: null | string;
    nowPlayingItem: null | Song;
    playState: RemoteMirroredPlayState;
    queue: Song[];
    queueIndex: number; // -1 if unknown
}

export interface RemoteMirroredPlayState {
    /** Derived from the session's PlayState.IsMuted. Mute is independent of
     *  volume — Jellyfin can report `IsMuted: true` while volume is non-zero. */
    isMuted: boolean;
    isPaused: boolean;
    /** Target playback speed (1.0 = normal), mirrored for display only when a
     *  peer reports `rate` over the MQTT lane. Optional — absent on the
     *  Jellyfin lane and from publishers that don't carry it. (D3) */
    playbackRate?: number;
    positionMs: number;
    /** `Date.now()` when positionMs was sampled — used to interpolate between polls. */
    positionSampledAt: number;
    repeatMode: string; // 'RepeatNone' | 'RepeatAll' | 'RepeatOne'
    /** Derived from the session's PlayState.PlaybackOrder === 'Shuffle'. */
    shuffle: boolean;
    volume: number; // 0-100
}

export type RemotePlayCommand = 'PlayLast' | 'PlayNext' | 'PlayNow';

export type RemotePlaystateCommand =
    | 'FastForward'
    | 'NextTrack'
    | 'Pause'
    | 'PlaylistIndex'
    | 'PlayPause'
    | 'PreviousTrack'
    | 'Rewind'
    | 'Seek'
    | 'Stop'
    | 'Unpause';

export type RemoteTargetStatus =
    | 'connected'
    | 'connecting'
    | 'idle'
    | 'offline'
    | 'reconnecting'
    | 'transferring';
