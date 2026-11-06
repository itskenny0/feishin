import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

// Persisted sidebar items keep the label of the language they were created in,
// so every sidebar surface re-labels them by id with the current translation.
export const useSidebarItemLabels = (): Record<string, string> => {
    const { t } = useTranslation();

    return useMemo(
        () => ({
            Albums: t('page.sidebar.albums'),
            Artists: t('page.sidebar.albumArtists'),
            'Artists-all': t('page.sidebar.artists'),
            Collections: t('page.sidebar.collections'),
            Favorites: t('page.sidebar.favorites'),
            Folders: t('page.sidebar.folders'),
            Genres: t('page.sidebar.genres'),
            Home: t('page.sidebar.home'),
            'Now Playing': t('page.sidebar.nowPlaying'),
            Playlists: t('page.sidebar.playlists'),
            Radio: t('page.sidebar.radio'),
            Search: t('page.sidebar.search'),
            Settings: t('page.sidebar.settings'),
            Tracks: t('page.sidebar.tracks'),
        }),
        [t],
    );
};
