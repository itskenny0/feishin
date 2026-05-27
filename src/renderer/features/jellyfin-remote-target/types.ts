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
    nowPlayingItem: null | Song;
    playState: RemoteMirroredPlayState;
    queue: Song[];
    queueIndex: number; // -1 if unknown
}

export interface RemoteMirroredPlayState {
    isPaused: boolean;
    positionMs: number;
    /** `Date.now()` when positionMs was sampled — used to interpolate between polls. */
    positionSampledAt: number;
    repeatMode: string; // 'RepeatNone' | 'RepeatAll' | 'RepeatOne'
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

export type RemoteTargetStatus = 'connected' | 'idle' | 'offline' | 'reconnecting';
