import { CSSProperties, ReactNode, Suspense, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './home-route.module.css';

import { HydrationBanner, SyncChip } from '/@/renderer/cache';
import { useGridCarouselContainerQuery } from '/@/renderer/components/grid-carousel/grid-carousel-v2';
import { NativeScrollArea } from '/@/renderer/components/native-scroll-area/native-scroll-area';
import { AlbumInfiniteCarousel } from '/@/renderer/features/albums/components/album-infinite-carousel';
import { FeaturedGenres } from '/@/renderer/features/home/components/featured-genres';
import {
    GenreGridSkeleton,
    HomeSkeleton,
} from '/@/renderer/features/home/components/home-skeleton';
import { PinnedShelf } from '/@/renderer/features/home/components/pinned-shelf';
import { ArtistShelf } from '/@/renderer/features/home/components/spotify-home/artist-shelf';
import { HomeEmpty } from '/@/renderer/features/home/components/spotify-home/home-empty';
import { HomeHero } from '/@/renderer/features/home/components/spotify-home/home-hero';
import { PlaylistShelf } from '/@/renderer/features/home/components/spotify-home/playlist-shelf';
import { QuickPicks } from '/@/renderer/features/home/components/spotify-home/quick-picks';
import { ShelfTitle } from '/@/renderer/features/home/components/spotify-home/shelf-title';
import { MobileDevicePickerButton } from '/@/renderer/features/jellyfin-remote-target';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { SongInfiniteCarousel } from '/@/renderer/features/songs/components/song-infinite-carousel';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { useStableContainerQuery } from '/@/renderer/hooks/use-container-query';
import { AppRoute } from '/@/renderer/router/routes';
import {
    HomeItem,
    resolveHomeSections,
    useCurrentServer,
    useHomeItems,
    useWindowSettings,
} from '/@/renderer/store';
import { Stack } from '/@/shared/components/stack/stack';
import { AlbumListSort, ServerType, SongListSort, SortOrder } from '/@/shared/types/domain-types';
import { Platform } from '/@/shared/types/types';

/**
 * Redesigned, Spotify-flavoured home page.
 *
 * Structure (top → bottom):
 *   1. Hero — time-of-day greeting on a now-playing-derived colour wash.
 *   2. Quick picks — a responsive grid of short wide tiles for the most
 *      recently-played albums (Spotify's Home top zone).
 *   3. A rhythm of horizontal-scroll shelves: Recently played, On repeat
 *      (most played), Recently added, Jump back in (random/discover),
 *      Recently released, Your favourite artists (circular), Your playlists,
 *      and Featured genres.
 *
 * All data is sourced from the app's existing query hooks (album/song infinite
 * carousels, album-artist/playlist list queries) so the page is real, cached,
 * and offline-aware — no bespoke API surface. Each section renders in its own
 * error boundary and Suspense fallback so one slow/failing shelf can't blank
 * the page, and every section self-collapses when it has no data, with a
 * single friendly empty state when nothing is available at all.
 */
// The home entrance stagger is a first-impression flourish; it plays once
// per app session so warm revisits paint immediately instead of fading the
// whole page in from transparent again.
let hasPlayedHomeEntrance = false;

const HomeRoute = () => {
    const { t } = useTranslation();
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const server = useCurrentServer();
    const { windowBarStyle } = useWindowSettings();
    const isMobileShell = useIsMobileShell();
    // The raw container query produces a fresh object (new `width`/`height`) on
    // every ResizeObserver tick. Threading that straight through would re-render
    // HomeRoute and bust every shelf's `memo` on each pixel change. Derive a
    // referentially-stable variant whose identity only changes when a
    // breakpoint boolean actually crosses; its `ref` is preserved so the
    // ResizeObserver stays attached to the content Stack below.
    const rawContainerQuery = useGridCarouselContainerQuery();
    const containerQuery = useStableContainerQuery(rawContainerQuery);

    const isJellyfin = server?.type === ServerType.JELLYFIN;

    // User-configured section visibility/order from Settings → General → Home.
    // Resolved against the live section set so legacy ids are dropped and any
    // newly-shipped section appears (enabled) in its canonical slot even when
    // the persisted config predates it — no settings migration required.
    const persistedHomeItems = useHomeItems();
    const homeSections = useMemo(
        () => resolveHomeSections(persistedHomeItems),
        [persistedHomeItems],
    );

    // After the first mount's stagger has played, later visits skip it (see
    // HomeRow). Flipped in an effect so the first render still animates.
    useEffect(() => {
        hasPlayedHomeEntrance = true;
    }, []);

    // Each row knows its slot index so the CSS stagger lines up with painted
    // order. We build the rows once and only rebuild them when the inputs they
    // actually depend on change (translation, server type, and the *stable*
    // container query) — not on every ResizeObserver tick. Recreating all ~10
    // shelf elements on each resize is what previously re-mounted the page's
    // entire shelf tree.
    // Build each toggleable section once, keyed by its HomeItem id, then emit
    // them in the user's saved order (disabled sections omitted). The hero
    // greeting row is *not* a section — it stays always-on (its own toggles
    // govern the greeting and lucky button) and is rendered ahead of the
    // configurable shelves below. Rebuilds only when the inputs the shelves
    // actually depend on change (translation, server type, the *stable*
    // container query) — not on every ResizeObserver tick.
    const sectionNodes: Record<HomeItem, ReactNode> = useMemo(
        () => ({
            // Your favourite artists (circular shelf).
            [HomeItem.ARTISTS]: (
                <ComponentErrorBoundary key="artists">
                    <ArtistShelf />
                </ComponentErrorBoundary>
            ),
            // Featured genres grid.
            [HomeItem.GENRES]: (
                <ComponentErrorBoundary key="featured-genres">
                    <Suspense fallback={<GenreGridSkeleton />}>
                        <FeaturedGenres />
                    </Suspense>
                </ComponentErrorBoundary>
            ),
            // Legacy ids never resolve to a node (filtered out of homeSections).
            [HomeItem.LIBRARY_STATS]: null,
            // On repeat (most played).
            [HomeItem.MOST_PLAYED]: (
                <ComponentErrorBoundary key="most-played">
                    {isJellyfin ? (
                        <SongInfiniteCarousel
                            containerQuery={containerQuery}
                            enableRefresh
                            queryKey={['home', 'song', 'mostPlayed'] as const}
                            rowCount={1}
                            sortBy={SongListSort.PLAY_COUNT}
                            sortOrder={SortOrder.DESC}
                            title={<ShelfTitle title={t('page.home.mostPlayed')} />}
                        />
                    ) : (
                        <AlbumInfiniteCarousel
                            containerQuery={containerQuery}
                            enableRefresh
                            queryKey={['home', 'album', 'mostPlayed'] as const}
                            rowCount={1}
                            sortBy={AlbumListSort.PLAY_COUNT}
                            sortOrder={SortOrder.DESC}
                            title={<ShelfTitle title={t('page.home.mostPlayed')} />}
                        />
                    )}
                </ComponentErrorBoundary>
            ),
            [HomeItem.NEW_SINCE_LAST_VISIT]: null,
            // Pinned items — styled like the quick-pick tiles so the top zone
            // reads as one block. Renders nothing when there are no pins.
            [HomeItem.PINNED]: (
                <ComponentErrorBoundary key="pinned">
                    <PinnedShelf />
                </ComponentErrorBoundary>
            ),
            // Your playlists (rounded-square shelf).
            [HomeItem.PLAYLISTS]: (
                <ComponentErrorBoundary key="playlists">
                    <PlaylistShelf />
                </ComponentErrorBoundary>
            ),
            [HomeItem.QUICK_FILTERS]: null,
            // Quick picks (recently-played albums as wide tiles).
            [HomeItem.QUICK_PICKS]: (
                <ComponentErrorBoundary key="quick-picks">
                    <QuickPicks />
                </ComponentErrorBoundary>
            ),
            // Jump back in / discover (random albums).
            [HomeItem.RANDOM]: (
                <ComponentErrorBoundary key="random">
                    <AlbumInfiniteCarousel
                        containerQuery={containerQuery}
                        enableRefresh
                        queryKey={['home', 'album', 'random'] as const}
                        rowCount={1}
                        sortBy={AlbumListSort.RANDOM}
                        sortOrder={SortOrder.ASC}
                        title={
                            <ShelfTitle
                                showAllRoute={AppRoute.LIBRARY_ALBUMS}
                                title={t('page.home.explore')}
                            />
                        }
                    />
                </ComponentErrorBoundary>
            ),

            // Recently added.
            [HomeItem.RECENTLY_ADDED]: (
                <ComponentErrorBoundary key="recently-added">
                    <AlbumInfiniteCarousel
                        containerQuery={containerQuery}
                        enableRefresh
                        queryKey={['home', 'album', 'recentlyAdded'] as const}
                        rowCount={1}
                        sortBy={AlbumListSort.RECENTLY_ADDED}
                        sortOrder={SortOrder.DESC}
                        title={
                            <ShelfTitle
                                showAllRoute={AppRoute.LIBRARY_ALBUMS}
                                title={t('page.home.newlyAdded')}
                            />
                        }
                    />
                </ComponentErrorBoundary>
            ),
            // Recently played. Jellyfin tracks play recency on songs, not
            // albums, so use the song carousel there; everything else albums.
            [HomeItem.RECENTLY_PLAYED]: (
                <ComponentErrorBoundary key="recently-played">
                    {isJellyfin ? (
                        <SongInfiniteCarousel
                            containerQuery={containerQuery}
                            enableRefresh
                            queryKey={['home', 'song', 'recentlyPlayed'] as const}
                            rowCount={1}
                            sortBy={SongListSort.RECENTLY_PLAYED}
                            sortOrder={SortOrder.DESC}
                            title={<ShelfTitle title={t('page.home.recentlyPlayed')} />}
                        />
                    ) : (
                        <AlbumInfiniteCarousel
                            containerQuery={containerQuery}
                            enableRefresh
                            queryKey={['home', 'album', 'recentlyPlayed'] as const}
                            rowCount={1}
                            sortBy={AlbumListSort.RECENTLY_PLAYED}
                            sortOrder={SortOrder.DESC}
                            title={<ShelfTitle title={t('page.home.recentlyPlayed')} />}
                        />
                    )}
                </ComponentErrorBoundary>
            ),
            // Recently released.
            [HomeItem.RECENTLY_RELEASED]: (
                <ComponentErrorBoundary key="recently-released">
                    <AlbumInfiniteCarousel
                        containerQuery={containerQuery}
                        enableRefresh
                        queryKey={['home', 'album', 'recentlyReleased'] as const}
                        rowCount={1}
                        sortBy={AlbumListSort.RELEASE_DATE}
                        sortOrder={SortOrder.DESC}
                        title={<ShelfTitle title={t('page.home.recentlyReleased')} />}
                    />
                </ComponentErrorBoundary>
            ),
        }),
        [containerQuery, isJellyfin, t],
    );

    const rows: ReactNode[] = useMemo(() => {
        const built: ReactNode[] = [
            // 1. Hero greeting + atmosphere (incl. the lucky button) — always on.
            <ComponentErrorBoundary key="hero">
                <HomeHero />
            </ComponentErrorBoundary>,
        ];

        // 2+. User-ordered, enabled sections.
        for (const section of homeSections) {
            if (section.disabled) continue;
            const node = sectionNodes[section.id];
            if (node) built.push(node);
        }

        return built;
    }, [homeSections, sectionNodes]);

    return (
        <AnimatedPage>
            <NativeScrollArea
                pageHeaderProps={{
                    backgroundColor: 'var(--theme-colors-background)',
                    children: (
                        <LibraryHeaderBar>
                            <LibraryHeaderBar.Title>{t('page.home.title')}</LibraryHeaderBar.Title>
                            <SyncChip />
                            {/* Cold-start Jellyfin Connect entry; self-gates to
                                Jellyfin servers. */}
                            {isMobileShell && <MobileDevicePickerButton iconSize="lg" />}
                        </LibraryHeaderBar>
                    ),
                    offset: 200,
                }}
                ref={scrollAreaRef}
                scrollKey="home"
            >
                <LibraryContainer>
                    <Stack
                        className={styles.contentStack}
                        gap="2xl"
                        mb="5rem"
                        pt={
                            isMobileShell
                                ? 'var(--theme-spacing-md)'
                                : windowBarStyle === Platform.WEB
                                  ? '5rem'
                                  : '3rem'
                        }
                        ref={containerQuery.ref}
                    >
                        {/* Cold-start Jellyfin Connect entry mirrored in the
                            content since the page-header copy only fades in on
                            scroll. Self-gates to Jellyfin servers. */}
                        {isMobileShell && (
                            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                <MobileDevicePickerButton iconSize="lg" variant="default" />
                            </div>
                        )}
                        <HydrationBanner />
                        {/* Second SyncChip mount — the header chip only appears
                            after scrolling past the 200px offset, so surface
                            one at the entry point during hydration. Both
                            self-gate so they're no-ops outside an active sweep. */}
                        <SyncChip />
                        {!server ? (
                            <HomeEmpty />
                        ) : (
                            rows.map((row, index) => (
                                <HomeRow
                                    index={index}
                                    key={(row as { key?: string }).key ?? `home-row-${index}`}
                                >
                                    {row}
                                </HomeRow>
                            ))
                        )}
                    </Stack>
                </LibraryContainer>
            </NativeScrollArea>
        </AnimatedPage>
    );
};

/**
 * Single-row wrapper that applies the staggered fade-in. The CSS keyframe
 * lives in `home-route.module.css`; the per-row `animation-delay` is
 * computed here so we don't need a CSS variable round-trip.
 *
 * The stagger plays ONCE per app session (see `hasPlayedHomeEntrance`). The
 * route remounts on every navigation, and replaying a 320ms from-transparent
 * fade each time made the whole page visibly "redraw" when the user came
 * back to Home — warm revisits now paint immediately.
 */
const HomeRow = ({ children, index }: { children: ReactNode; index: number }) => {
    const animate = !hasPlayedHomeEntrance;
    const style: CSSProperties | undefined = animate
        ? { animationDelay: `${index * 70}ms` }
        : undefined;
    return (
        <div className={animate ? styles.row : undefined} style={style}>
            {children}
        </div>
    );
};

const HomeRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            {/* Shaped full-layout skeleton instead of a centered spinner so the
                lazy route-chunk load paints a layout-shaped placeholder with no
                jarring shift. */}
            <Suspense fallback={<HomeSkeleton />}>
                <HomeRoute />
            </Suspense>
        </PageErrorBoundary>
    );
};

export default HomeRouteWithBoundary;
