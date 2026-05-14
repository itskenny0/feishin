import { AppRoute } from '/@/renderer/router/routes';

/**
 * Maps a route path to its lazy-chunk preload function. The preload functions
 * are the same `import()` calls used by the `lazy()` wrappers in app-router.tsx;
 * Vite/webpack dedupe these by module identity, so calling them ahead of time
 * just warms the chunk cache without double-fetching.
 *
 * Used by sidebar items: `onMouseEnter` fires the preload, so by the time the
 * user finishes the click, the chunk is already parsed and the Suspense
 * boundary resolves immediately.
 */
const preloaders: Partial<Record<AppRoute, () => Promise<unknown>>> = {
    [AppRoute.FAVORITES]: () => import('/@/renderer/features/favorites/routes/favorites-route'),
    [AppRoute.HOME]: () => import('/@/renderer/features/home/routes/home-route'),
    [AppRoute.LIBRARY_ALBUM_ARTISTS]: () =>
        import('/@/renderer/features/artists/routes/album-artist-list-route'),
    [AppRoute.LIBRARY_ALBUMS]: () => import('/@/renderer/features/albums/routes/album-list-route'),
    [AppRoute.LIBRARY_ARTISTS]: () =>
        import('/@/renderer/features/artists/routes/artist-list-route'),
    [AppRoute.LIBRARY_FOLDERS]: () =>
        import('/@/renderer/features/folders/routes/folder-list-route'),
    [AppRoute.LIBRARY_GENRES]: () => import('/@/renderer/features/genres/routes/genre-list-route'),
    [AppRoute.LIBRARY_SONGS]: () => import('/@/renderer/features/songs/routes/song-list-route'),
    [AppRoute.NOW_PLAYING]: () =>
        import('/@/renderer/features/now-playing/routes/now-playing-route'),
    [AppRoute.PLAYLISTS]: () => import('/@/renderer/features/playlists/routes/playlist-list-route'),
    [AppRoute.RADIO]: () => import('/@/renderer/features/radio/routes/radio-list-route'),
    [AppRoute.SEARCH]: () => import('/@/renderer/features/search/routes/search-route'),
    [AppRoute.SETTINGS]: () => import('/@/renderer/features/settings/routes/settings-route'),
};

const inFlight = new Set<string>();

/**
 * Warm the route chunk for the given path. Idempotent; only fires once per
 * route per session. Safe to call from synthetic event handlers (no awaiting
 * required).
 */
export const preloadRoute = (to: string): void => {
    const route = to as AppRoute;
    const preloader = preloaders[route];
    if (!preloader || inFlight.has(route)) return;
    inFlight.add(route);
    void preloader().catch(() => {
        // Network/parse failure — let the normal Suspense boundary handle it
        // when the user actually navigates. Drop from the set so a retry on
        // the user's next hover can re-trigger the fetch.
        inFlight.delete(route);
    });
};
