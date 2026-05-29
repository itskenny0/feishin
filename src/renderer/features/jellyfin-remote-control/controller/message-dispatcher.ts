import { t } from 'i18next';

import {
    JellyfinIncomingMessage,
    JellyfinPlayCommand,
} from '/@/renderer/features/jellyfin-remote-control/types';
import {
    addToQueueByData,
    isShuffleEnabled,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { toast } from '/@/shared/components/toast/toast';
import { Song } from '/@/shared/types/domain-types';
import { Play, PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

const DEBUG =
    typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;

const debug = (...args: unknown[]) => {
    if (DEBUG) console.log('[jellyfin-remote]', ...args);
};

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
        // NOTE: name says "Timestamp" but the underlying store action expects
        // SECONDS, not milliseconds. The previous typedef said `ms: number`
        // which silently produced a 1000× seek bug fixed in commit 4205727d.
        mediaSeekToTimestamp: (seconds: number) => void;
        mediaSkipBackward: () => void;
        mediaSkipForward: () => void;
        mediaStop: (args?: { reset?: boolean }) => void;
        mediaToggleMute: () => void;
        mediaTogglePlayPause: () => void;
        setRepeat: (repeat: PlayerRepeat) => void;
        setShuffle: (shuffle: PlayerShuffle) => void;
        setVolume: (volume: number) => void;
    };
}

const PLAY_COMMAND_TO_PLAY_TYPE: Record<JellyfinPlayCommand, Play> = {
    PlayLast: Play.LAST,
    PlayNext: Play.NEXT,
    PlayNow: Play.NOW,
};

// Jellyfin "ticks" are 100-ns units; one second = 10_000_000 ticks.
const TICKS_PER_SECOND = 10_000_000;

export async function dispatchJellyfinMessage(
    msg: JellyfinIncomingMessage,
    deps: DispatcherDeps,
): Promise<void> {
    const { defaultVolumeStep, fetchSongsByIds, playerActions } = deps;

    if (msg.MessageType === 'Playstate') {
        const data = (msg as Extract<JellyfinIncomingMessage, { MessageType: 'Playstate' }>).Data;
        // A malformed frame with Data omitted/null must be ignored like any
        // other unknown shape rather than throwing inside this async fn (the
        // throw would be swallowed by the caller's .catch and drop the frame
        // with a console.error instead of a graceful no-op).
        if (!data || typeof data.Command !== 'string') return;
        debug('Playstate', data.Command);
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
                playerActions.mediaSeekToTimestamp(ticks / TICKS_PER_SECOND);
                return;
            }
            case 'Stop':
                // The Jellyfin "Stop" command semantically means "stop
                // playback" rather than "rewind to start". Preserve position
                // so the user can resume from a remote later.
                playerActions.mediaStop({ reset: false });
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
        // Guard a missing/null Data so a non-conformant frame is ignored
        // (matching the default fallthrough) instead of throwing on data.Name.
        if (!data || typeof data.Name !== 'string') return;
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
            case 'SetRepeatMode': {
                const mode = args.RepeatMode;
                playerActions.setRepeat(
                    mode === 'RepeatAll'
                        ? PlayerRepeat.ALL
                        : mode === 'RepeatOne'
                          ? PlayerRepeat.ONE
                          : PlayerRepeat.NONE,
                );
                return;
            }
            case 'SetShuffleQueue': {
                playerActions.setShuffle(
                    args.ShuffleMode === 'Shuffle' ? PlayerShuffle.TRACK : PlayerShuffle.NONE,
                );
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
        // Guard a missing/null Data before reading data.PlayCommand so a
        // malformed Play frame is ignored gracefully.
        if (!data) return;
        const playType = PLAY_COMMAND_TO_PLAY_TYPE[data.PlayCommand];
        if (!playType) return;
        const ids = data.ItemIds ?? [];
        if (ids.length === 0) return;
        const startIndex = data.StartIndex ?? 0;
        const startPositionTicks = data.StartPositionTicks ?? 0;

        // Fast path: if the requested ItemIds match the current playback-order
        // queue exactly, the user clicked an item already in our queue from the
        // remote — just jump to that position rather than re-fetching and
        // replacing.
        if (playType === Play.NOW) {
            const state = usePlayerStoreBase.getState();
            const songsById = state.queue.songs;
            const defaultIds = state.queue.default;
            const orderedUids = isShuffleEnabled(state)
                ? state.queue.shuffled
                      .map((idx) => defaultIds[idx])
                      .filter((id): id is string => Boolean(id))
                : defaultIds;
            const orderedItemIds = orderedUids
                .map((uid) => songsById[uid]?.id)
                .filter((id): id is string => Boolean(id));

            const matchesCurrentQueue =
                orderedItemIds.length === ids.length &&
                orderedItemIds.every((id, i) => id === ids[i]);

            if (matchesCurrentQueue && startIndex >= 0 && startIndex < orderedItemIds.length) {
                // mediaPlayByIndex takes a default-queue index; map back from the
                // shuffled position the remote sent us.
                const defaultIndex = isShuffleEnabled(state)
                    ? (state.queue.shuffled[startIndex] ?? startIndex)
                    : startIndex;
                state.mediaPlayByIndex(defaultIndex);
                if (startPositionTicks > 0) {
                    // Defer past the track-change render so the new song's
                    // media element is mounted by the time the seek lands.
                    // Mirrors the fresh-queue path below; without this the
                    // seek can hit the old/zeroed element and the requested
                    // resume position is silently lost.
                    requestAnimationFrame(() => {
                        playerActions.mediaSeekToTimestamp(startPositionTicks / TICKS_PER_SECOND);
                    });
                }
                return;
            }
        }

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

        // If the remote sent PlayNext/PlayLast while we're idle, auto-start
        // playback once the queue is populated — otherwise the user clicks
        // "Add to queue" from Jellyfin Web and nothing visibly happens.
        const wasIdle = usePlayerStoreBase.getState().queue.default.length === 0;
        const effectivePlayType = wasIdle ? Play.NOW : playType;

        await addToQueueByData(effectivePlayType, songs);

        // Honor StartIndex / StartPositionTicks for fresh-queue plays too.
        //
        // The remote sends StartIndex relative to ItemIds (i.e. relative to
        // the order of `songs` after fetchSongsByIds preserves ItemIds
        // order). For the fresh-queue path we just enqueued `songs` in that
        // same order, so we want to play `songs[startIndex]`. The default
        // queue indexing matches songs[] order, so we pass startIndex
        // directly — NO shuffle-map translation (the fast-path's translation
        // exists because it's matching against an EXISTING shuffled queue;
        // here the queue is fresh).
        if (effectivePlayType === Play.NOW) {
            if (startIndex > 0 && startIndex < songs.length) {
                usePlayerStoreBase.getState().mediaPlayByIndex(startIndex);
            }
            if (startPositionTicks > 0) {
                // Defer so the new song's media element is mounted by the
                // time the seek lands. A microtask is enough; rAF as belt.
                requestAnimationFrame(() => {
                    playerActions.mediaSeekToTimestamp(startPositionTicks / TICKS_PER_SECOND);
                });
            }
        }
        return;
    }

    // Unknown / KeepAlive / Sessions / ForceKeepAlive / UserDataChanged — ignore.
}
