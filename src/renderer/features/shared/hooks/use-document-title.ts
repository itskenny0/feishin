import { useEffect } from 'react';

import { usePlayerSong, usePlayerStatus } from '/@/renderer/store/player.store';
import { PlayerStatus } from '/@/shared/types/types';

const APP_NAME = 'Feishin';

/**
 * Side-effect hook: keeps document.title in sync with the currently-playing
 * track. When the user is playing a song, the OS tab/window chrome shows
 * "Song Title — Artist · Feishin"; otherwise it falls back to plain "Feishin".
 *
 * Mount once at the top of the app tree; the hook is idempotent across renders.
 */
export const useDocumentTitle = () => {
    const song = usePlayerSong();
    const status = usePlayerStatus();

    useEffect(() => {
        const isPlaying = status === PlayerStatus.PLAYING;
        if (isPlaying && song?.name) {
            const artist = song.artists?.[0]?.name ?? song.artistName;
            document.title = artist
                ? `${song.name} — ${artist} · ${APP_NAME}`
                : `${song.name} · ${APP_NAME}`;
        } else {
            document.title = APP_NAME;
        }
        // Restore on unmount to keep the title sensible if the app shell remounts.
        return () => {
            document.title = APP_NAME;
        };
    }, [song?.name, song?.artists, song?.artistName, status]);
};
