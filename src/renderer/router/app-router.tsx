import type { ComponentProps } from 'react';

import { lazy, Suspense } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router';

import { FolderPlaylistMigrationModal } from '/@/renderer/features/folders/components/folder-playlist-migration-modal';
import { ShuffleAllContextModal } from '/@/renderer/features/player/components/shuffle-all-modal';
import { SettingsContextModal } from '/@/renderer/features/settings/components/settings-modal';
import { RouterErrorBoundary } from '/@/renderer/features/shared/components/router-error-boundary';
import { ShortcutsHelpContextModal } from '/@/renderer/features/shortcuts/components/shortcuts-help-modal';
import { AuthenticationOutlet } from '/@/renderer/layouts/authentication-outlet';
import { ResponsiveLayout } from '/@/renderer/layouts/responsive-layout';
import { AppOutlet } from '/@/renderer/router/app-outlet';
import { AppRoute } from '/@/renderer/router/routes';
import { TitlebarOutlet } from '/@/renderer/router/titlebar-outlet';
import { BaseContextModal, ModalsProvider } from '/@/shared/components/modal/modal';
import { Spinner } from '/@/shared/components/spinner/spinner';

const NowPlayingRoute = lazy(
    () => import('/@/renderer/features/now-playing/routes/now-playing-route'),
);

const AlbumListRoute = lazy(() => import('/@/renderer/features/albums/routes/album-list-route'));

const SongListRoute = lazy(() => import('/@/renderer/features/songs/routes/song-list-route'));

const OfflineSongListRoute = lazy(
    () => import('/@/renderer/features/songs/routes/offline-song-list-route'),
);

const PlaylistDetailSongListRoute = lazy(
    () => import('/@/renderer/features/playlists/routes/playlist-detail-song-list-route'),
);

const PlaylistListRoute = lazy(
    () => import('/@/renderer/features/playlists/routes/playlist-list-route'),
);

const ActionRequiredRoute = lazy(
    () => import('/@/renderer/features/action-required/routes/action-required-route'),
);

const InvalidRoute = lazy(
    () => import('/@/renderer/features/action-required/routes/invalid-route'),
);

const LoginRoute = lazy(() => import('/@/renderer/features/login/routes/login-route'));

const NoNetworkRoute = lazy(
    () => import('/@/renderer/features/action-required/routes/no-network-route'),
);

const HomeRoute = lazy(() => import('/@/renderer/features/home/routes/home-route'));

const ArtistListRoute = lazy(() => import('/@/renderer/features/artists/routes/artist-list-route'));

const AlbumArtistListRoute = lazy(
    () => import('/@/renderer/features/artists/routes/album-artist-list-route'),
);

const AlbumArtistDetailRoute = lazy(
    () => import('/@/renderer/features/artists/routes/album-artist-detail-route'),
);

const AlbumArtistDetailTopSongsListRoute = lazy(
    () => import('../features/artists/routes/album-artist-detail-top-songs-list-route'),
);

const AlbumArtistDetailFavoriteSongsListRoute = lazy(
    () => import('../features/artists/routes/album-artist-detail-favorite-songs-list-route'),
);

const AlbumDetailRoute = lazy(
    () => import('/@/renderer/features/albums/routes/album-detail-route'),
);

const DummyAlbumDetailRoute = lazy(
    () => import('/@/renderer/features/albums/routes/dummy-album-detail-route'),
);

const GenreListRoute = lazy(() => import('/@/renderer/features/genres/routes/genre-list-route'));

const GenreDetailRoute = lazy(
    () => import('/@/renderer/features/genres/routes/genre-detail-route'),
);

const FolderListRoute = lazy(() => import('/@/renderer/features/folders/routes/folder-list-route'));

const RadioListRoute = lazy(() => import('/@/renderer/features/radio/routes/radio-list-route'));

const SearchRoute = lazy(() => import('/@/renderer/features/search/routes/search-route'));

const UnifiedSearchRoute = lazy(
    () => import('/@/renderer/features/search/routes/unified-search-route'),
);

const CommandPaletteRoute = lazy(
    () => import('/@/renderer/features/search/routes/command-palette-route'),
);

const FavoritesRoute = lazy(() => import('/@/renderer/features/favorites/routes/favorites-route'));

const SettingsRoute = lazy(() => import('/@/renderer/features/settings/routes/settings-route'));

const LazyLyricsSettingsContextModal = lazy(() =>
    import('/@/renderer/features/lyrics/components/lyrics-settings-modal').then((module) => ({
        default: module.LyricsSettingsContextModal,
    })),
);

const LyricsSettingsContextModal = (
    props: ComponentProps<typeof LazyLyricsSettingsContextModal>,
) => (
    <Suspense fallback={<Spinner container />}>
        <LazyLyricsSettingsContextModal {...props} />
    </Suspense>
);

const LazyAddToPlaylistContextModal = lazy(() =>
    import('/@/renderer/features/playlists/components/add-to-playlist-context-modal').then(
        (module) => ({
            default: module.AddToPlaylistContextModal,
        }),
    ),
);

const AddToPlaylistContextModal = (props: ComponentProps<typeof LazyAddToPlaylistContextModal>) => (
    <Suspense fallback={<Spinner container />}>
        <LazyAddToPlaylistContextModal {...props} />
    </Suspense>
);

const LazySaveAndReplaceContextModal = lazy(() =>
    import('/@/renderer/features/playlists/components/save-and-replace-context-modal').then(
        (module) => ({
            default: module.SaveAndReplaceContextModal,
        }),
    ),
);

const SaveAndReplaceContextModal = (
    props: ComponentProps<typeof LazySaveAndReplaceContextModal>,
) => (
    <Suspense fallback={<Spinner container />}>
        <LazySaveAndReplaceContextModal {...props} />
    </Suspense>
);

const LazyUpdatePlaylistContextModal = lazy(() =>
    import('/@/renderer/features/playlists/components/update-playlist-form').then((module) => ({
        default: module.UpdatePlaylistContextModal,
    })),
);

const UpdatePlaylistContextModal = (
    props: ComponentProps<typeof LazyUpdatePlaylistContextModal>,
) => (
    <Suspense fallback={<Spinner container />}>
        <LazyUpdatePlaylistContextModal {...props} />
    </Suspense>
);

const LazyShareItemContextModal = lazy(() =>
    import('/@/renderer/features/sharing/components/share-item-context-modal').then((module) => ({
        default: module.ShareItemContextModal,
    })),
);

const ShareItemContextModal = (props: ComponentProps<typeof LazyShareItemContextModal>) => (
    <Suspense fallback={<Spinner container />}>
        <LazyShareItemContextModal {...props} />
    </Suspense>
);

const LazyVisualizerSettingsContextModal = lazy(() =>
    import('/@/renderer/features/visualizer/components/audiomotionanalyzer/visualizer-settings-modal').then(
        (module) => ({
            default: module.VisualizerSettingsContextModal,
        }),
    ),
);

// Zero-prop modal (see SettingsContextModal above) — render bare.
const VisualizerSettingsContextModal = () => (
    <Suspense fallback={<Spinner container />}>
        <LazyVisualizerSettingsContextModal />
    </Suspense>
);

const LazySongEditContextModal = lazy(() =>
    import('/@/renderer/features/tag-editor/components/song-edit-context-modal').then((module) => ({
        default: module.SongEditContextModal,
    })),
);

const SongEditContextModal = (props: any) => (
    <Suspense fallback={<Spinner container />}>
        <LazySongEditContextModal {...props} />
    </Suspense>
);

const appRouterModals = {
    addToPlaylist: AddToPlaylistContextModal,
    base: BaseContextModal,
    editMetadata: SongEditContextModal,
    folderPlaylistMigration: FolderPlaylistMigrationModal,
    lyricsSettings: LyricsSettingsContextModal,
    saveAndReplace: SaveAndReplaceContextModal,
    settings: SettingsContextModal,
    shareItem: ShareItemContextModal,
    shortcutsHelp: ShortcutsHelpContextModal,
    shuffleAll: ShuffleAllContextModal,
    updatePlaylist: UpdatePlaylistContextModal,
    visualizerSettings: VisualizerSettingsContextModal,
};

export const AppRouter = () => {
    const router = (
        <HashRouter useTransitions={false}>
            <ModalsProvider modals={appRouterModals}>
                <RouterErrorBoundary>
                    <Routes>
                        <Route element={<AuthenticationOutlet />}>
                            <Route element={<TitlebarOutlet />}>
                                <Route element={<AppOutlet />}>
                                    <Route element={<ResponsiveLayout />}>
                                        <Route element={<HomeRoute />} index />
                                        <Route element={<HomeRoute />} path={AppRoute.HOME} />
                                        <Route
                                            element={<UnifiedSearchRoute />}
                                            path={AppRoute.SEARCH_INDEX}
                                        />
                                        <Route element={<SearchRoute />} path={AppRoute.SEARCH} />
                                        <Route
                                            element={<CommandPaletteRoute />}
                                            path={AppRoute.COMMAND}
                                        />
                                        <Route
                                            element={<FavoritesRoute />}
                                            path={AppRoute.FAVORITES}
                                        />
                                        <Route
                                            element={<SettingsRoute />}
                                            path={AppRoute.SETTINGS}
                                        />
                                        <Route
                                            element={<NowPlayingRoute />}
                                            path={AppRoute.NOW_PLAYING}
                                        />
                                        <Route path={AppRoute.LIBRARY_GENRES}>
                                            <Route element={<GenreListRoute />} index />
                                            <Route
                                                element={<GenreDetailRoute />}
                                                path={AppRoute.LIBRARY_GENRES_DETAIL}
                                            />
                                        </Route>
                                        <Route
                                            element={<AlbumListRoute />}
                                            path={AppRoute.LIBRARY_ALBUMS}
                                        />
                                        <Route
                                            element={<AlbumDetailRoute />}
                                            path={AppRoute.LIBRARY_ALBUMS_DETAIL}
                                        />
                                        <Route
                                            element={<ArtistListRoute />}
                                            path={AppRoute.LIBRARY_ARTISTS}
                                        />
                                        <Route path={AppRoute.LIBRARY_ARTISTS_DETAIL}>
                                            <Route element={<AlbumArtistDetailRoute />} index />
                                            <Route
                                                element={<AlbumListRoute />}
                                                path={AppRoute.LIBRARY_ARTISTS_DETAIL_DISCOGRAPHY}
                                            />
                                            <Route
                                                element={<SongListRoute />}
                                                path={AppRoute.LIBRARY_ARTISTS_DETAIL_SONGS}
                                            />
                                            <Route
                                                element={<AlbumArtistDetailTopSongsListRoute />}
                                                path={AppRoute.LIBRARY_ARTISTS_DETAIL_TOP_SONGS}
                                            />
                                            <Route
                                                element={
                                                    <AlbumArtistDetailFavoriteSongsListRoute />
                                                }
                                                path={
                                                    AppRoute.LIBRARY_ARTISTS_DETAIL_FAVORITE_SONGS
                                                }
                                            />
                                        </Route>
                                        <Route
                                            element={<DummyAlbumDetailRoute />}
                                            path={AppRoute.FAKE_LIBRARY_ALBUM_DETAILS}
                                        />
                                        <Route
                                            element={<SongListRoute />}
                                            path={AppRoute.LIBRARY_SONGS}
                                        />
                                        <Route
                                            element={<OfflineSongListRoute />}
                                            path={AppRoute.LIBRARY_OFFLINE}
                                        />
                                        <Route
                                            element={<FolderListRoute />}
                                            path={AppRoute.LIBRARY_FOLDERS}
                                        />
                                        <Route
                                            element={<PlaylistListRoute />}
                                            path={AppRoute.PLAYLISTS}
                                        />
                                        <Route element={<RadioListRoute />} path={AppRoute.RADIO} />
                                        <Route
                                            element={<PlaylistDetailSongListRoute />}
                                            path={AppRoute.PLAYLISTS_DETAIL_SONGS}
                                        />
                                        <Route path={AppRoute.LIBRARY_ALBUM_ARTISTS}>
                                            <Route element={<AlbumArtistListRoute />} index />
                                            <Route path={AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL}>
                                                <Route element={<AlbumArtistDetailRoute />} index />
                                                <Route
                                                    element={<AlbumListRoute />}
                                                    path={
                                                        AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL_DISCOGRAPHY
                                                    }
                                                />
                                                <Route
                                                    element={<SongListRoute />}
                                                    path={
                                                        AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL_SONGS
                                                    }
                                                />
                                                <Route
                                                    element={<AlbumArtistDetailTopSongsListRoute />}
                                                    path={
                                                        AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL_TOP_SONGS
                                                    }
                                                />
                                                <Route
                                                    element={
                                                        <AlbumArtistDetailFavoriteSongsListRoute />
                                                    }
                                                    path={
                                                        AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL_FAVORITE_SONGS
                                                    }
                                                />
                                            </Route>
                                        </Route>
                                        <Route element={<InvalidRoute />} path="*" />
                                    </Route>
                                </Route>
                            </Route>
                        </Route>
                        <Route element={<TitlebarOutlet />}>
                            <Route element={<ResponsiveLayout shell />}>
                                <Route
                                    element={<ActionRequiredRoute />}
                                    path={AppRoute.ACTION_REQUIRED}
                                />
                                <Route element={<LoginRoute />} path={AppRoute.LOGIN} />
                            </Route>
                            <Route element={<ResponsiveLayout />}>
                                <Route element={<NoNetworkRoute />} path={AppRoute.NO_NETWORK} />
                            </Route>
                        </Route>
                        {/*
                         * Top-level catch-all. The InvalidRoute below sits
                         * INSIDE the auth gate, so a signed-out user that
                         * deep-links to a non-existent path would otherwise
                         * see a blank screen (the no-auth siblings have no
                         * `*` of their own). Redirecting to ACTION_REQUIRED
                         * lands them on the recovery flow regardless of
                         * auth state — once they auth, AppOutlet routes
                         * them home as normal.
                         */}
                        <Route
                            element={<Navigate replace to={AppRoute.ACTION_REQUIRED} />}
                            path="*"
                        />
                    </Routes>
                </RouterErrorBoundary>
            </ModalsProvider>
        </HashRouter>
    );

    return router;
};
