import { usePlayerStoreBase } from '/@/renderer/store';
import { QueueSong, Song } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';

/**
 * Returns whether the provided song is the currently-active player song.
 *
 * The selector resolves to a boolean so Zustand bails out for the ~all-false
 * cells: a track change only re-renders the cell that flips from/to active,
 * instead of fanning out across every visible row.
 */
export const useIsCurrentSong = (song: QueueSong | Song) => {
    const queueSong = song as QueueSong;
    const hasUniqueId = queueSong._uniqueId != null && queueSong._uniqueId !== '';

    const isActive = usePlayerStoreBase((state) => {
        const currentSong = state.getCurrentSong();

        if (hasUniqueId) {
            return queueSong._uniqueId === currentSong?._uniqueId;
        }

        return song.id === currentSong?.id;
    });

    return { isActive };
};

/**
 * Boolean selector for whether the provided song is both the active song and
 * currently playing. Keyed to the song identity so unrelated cells bail out.
 */
export const useIsCurrentSongPlaying = (song: QueueSong | Song) => {
    const queueSong = song as QueueSong;
    const hasUniqueId = queueSong._uniqueId != null && queueSong._uniqueId !== '';

    return usePlayerStoreBase((state) => {
        if (state.player.status !== PlayerStatus.PLAYING) {
            return false;
        }

        const currentSong = state.getCurrentSong();

        if (hasUniqueId) {
            return queueSong._uniqueId === currentSong?._uniqueId;
        }

        return song.id === currentSong?.id;
    });
};
