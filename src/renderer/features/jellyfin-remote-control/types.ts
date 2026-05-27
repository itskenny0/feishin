export interface JellyfinGeneralCommandMessage {
    Data: {
        Arguments?: Record<string, string>;
        ControllingUserId?: string;
        Name: JellyfinGeneralCommandName | string;
    };
    MessageId?: string;
    MessageType: 'GeneralCommand';
}

export type JellyfinGeneralCommandName =
    | 'DisplayMessage'
    | 'Mute'
    | 'SetRepeatMode'
    | 'SetShuffleQueue'
    | 'SetVolume'
    | 'ToggleMute'
    | 'Unmute'
    | 'VolumeDown'
    | 'VolumeUp';

export type JellyfinIncomingMessage =
    | JellyfinGeneralCommandMessage
    | JellyfinPlayMessage
    | JellyfinPlaystateMessage
    | { Data?: unknown; MessageId?: string; MessageType: string };

export type JellyfinPlayCommand = 'PlayLast' | 'PlayNext' | 'PlayNow';

export interface JellyfinPlayMessage {
    Data: {
        ControllingUserId?: string;
        ItemIds: string[];
        PlayCommand: JellyfinPlayCommand;
        StartIndex?: number;
        StartPositionTicks?: number;
    };
    MessageId?: string;
    MessageType: 'Play';
}

export type JellyfinPlaystateCommand =
    | 'FastForward'
    | 'NextTrack'
    | 'Pause'
    | 'PlayPause'
    | 'PreviousTrack'
    | 'Rewind'
    | 'Seek'
    | 'Stop'
    | 'Unpause';

export interface JellyfinPlaystateMessage {
    Data: {
        Command: JellyfinPlaystateCommand;
        ControllingUserId?: string;
        SeekPositionTicks?: number;
    };
    MessageId?: string;
    MessageType: 'Playstate';
}
