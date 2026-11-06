import { useCallback } from 'react';
import { useSearchParams } from 'react-router';

import { ALBUM_FILTER_RESET } from '/@/renderer/features/albums/hooks/use-album-list-filters';
import { SONG_FILTER_RESET } from '/@/renderer/features/songs/hooks/use-song-list-filters';
import { GenreTarget, useGenreTarget, useSettingsStoreActions } from '/@/renderer/store';
import { setMultipleSearchParams } from '/@/renderer/utils/query-params';
import { runInUrlTransition } from '/@/renderer/utils/url-transition';

/**
 * Switch the genre page between albums and tracks, clearing both filter sets
 * in ONE url update: two functional setSearchParams calls in the same handler
 * both receive the same stale params, so the second would restore the keys the
 * first cleared.
 */
export const useToggleGenreTarget = () => {
    const target = useGenreTarget();
    const { setGenreBehavior } = useSettingsStoreActions();
    const [, setSearchParams] = useSearchParams();

    return useCallback(() => {
        runInUrlTransition(() => {
            setSearchParams(
                (prev) =>
                    setMultipleSearchParams(prev, { ...ALBUM_FILTER_RESET, ...SONG_FILTER_RESET }),
                { replace: true },
            );
        });
        setGenreBehavior(target === GenreTarget.ALBUM ? GenreTarget.TRACK : GenreTarget.ALBUM);
    }, [setGenreBehavior, setSearchParams, target]);
};
