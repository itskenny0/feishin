import { t } from 'i18next';

import {
    JellyfinIncomingMessage,
    JellyfinPlayCommand,
} from '/@/renderer/features/jellyfin-remote-control/types';
import { addToQueueByData, usePlayerStoreBase } from '/@/renderer/store/player.store';
import { toast } from '/@/shared/components/toast/toast';
import { Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

export interface DispatcherDeps {
    defaultVolumeStep: number;
    fetchSongsByIds: (itemIds: string[]) => Promise<Song[]>;
    playerActions: {
        decreaseVolume: (step: number) => void;
        increaseVolume: (step: number) => void;
        mediaNext: () => void;
        mediaPause: () => void;
        mediaPlay: () => void;
        mediaPrevious: () => void;
        mediaSeekToTimestamp: (ms: number) => void;
        mediaSkipBackward: () => void;
        mediaSkipForward: () => void;
        mediaStop: (args?: { reset?: boolean }) => void;
        mediaToggleMute: () => void;
        mediaTogglePlayPause: () => void;
        setVolume: (volume: number) => void;
    };
}

const PLAY_COMMAND_TO_PLAY_TYPE: Record<JellyfinPlayCommand, Play> = {
    PlayLast: Play.LAST,
    PlayNext: Play.NEXT,
    PlayNow: Play.NOW,
};

export async function dispatchJellyfinMessage(
    msg: JellyfinIncomingMessage,
    deps: DispatcherDeps,
): Promise<void> {
    const { defaultVolumeStep, fetchSongsByIds, playerActions } = deps;

    if (msg.MessageType === 'Playstate') {
        const data = (msg as Extract<JellyfinIncomingMessage, { MessageType: 'Playstate' }>).Data;
        switch (data.Command) {
            case 'FastForward':
                playerActions.mediaSkipForward();
                return;
            case 'NextTrack':
                playerActions.mediaNext();
                return;
            case 'Pause':
                playerActions.mediaPause();
                return;
            case 'PlayPause':
                playerActions.mediaTogglePlayPause();
                return;
            case 'PreviousTrack':
                playerActions.mediaPrevious();
                return;
            case 'Rewind':
                playerActions.mediaSkipBackward();
                return;
            case 'Seek': {
                const ticks = data.SeekPositionTicks ?? 0;
                // Jellyfin "ticks" = 100-ns units; ms = ticks / 10_000.
                playerActions.mediaSeekToTimestamp(Math.round(ticks / 10000));
                return;
            }
            case 'Stop':
                playerActions.mediaStop();
                return;
            case 'Unpause':
                playerActions.mediaPlay();
                return;
            default:
                return;
        }
    }

    if (msg.MessageType === 'GeneralCommand') {
        const data = (msg as Extract<JellyfinIncomingMessage, { MessageType: 'GeneralCommand' }>)
            .Data;
        const args = data.Arguments ?? {};
        switch (data.Name) {
            case 'DisplayMessage': {
                const header = args.Header ?? '';
                const text = args.Text ?? '';
                toast.info({
                    message: text || header,
                    title: header || undefined,
                });
                return;
            }
            case 'Mute': {
                const muted = usePlayerStoreBase.getState().player.muted;
                if (!muted) playerActions.mediaToggleMute();
                return;
            }
            case 'SetVolume': {
                const raw = args.Volume;
                if (raw === undefined) return;
                const parsed = parseInt(raw, 10);
                if (Number.isNaN(parsed)) return;
                // Both Jellyfin and Feishin use 0–100.
                playerActions.setVolume(Math.max(0, Math.min(100, parsed)));
                return;
            }
            case 'ToggleMute':
                playerActions.mediaToggleMute();
                return;
            case 'Unmute': {
                const muted = usePlayerStoreBase.getState().player.muted;
                if (muted) playerActions.mediaToggleMute();
                return;
            }
            case 'VolumeDown':
                playerActions.decreaseVolume(defaultVolumeStep);
                return;
            case 'VolumeUp':
                playerActions.increaseVolume(defaultVolumeStep);
                return;
            default:
                return;
        }
    }

    if (msg.MessageType === 'Play') {
        const data = (msg as Extract<JellyfinIncomingMessage, { MessageType: 'Play' }>).Data;
        const playType = PLAY_COMMAND_TO_PLAY_TYPE[data.PlayCommand];
        if (!playType) return;
        const ids = data.ItemIds ?? [];
        if (ids.length === 0) return;

        let songs: Song[];
        try {
            songs = await fetchSongsByIds(ids);
        } catch (err) {
            console.error('[jellyfin-remote] failed to resolve Play ItemIds', err);
            toast.error({
                message: t('error.genericError', { postProcess: 'sentenceCase' }) as string,
            });
            return;
        }

        if (songs.length === 0) {
            toast.error({
                message: t('error.genericError', { postProcess: 'sentenceCase' }) as string,
            });
            return;
        }

        await addToQueueByData(playType, songs);
        return;
    }

    // Unknown / KeepAlive / Sessions / ForceKeepAlive / UserDataChanged — ignore.
}
