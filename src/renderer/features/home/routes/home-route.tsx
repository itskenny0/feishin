import { CSSProperties, ReactNode, Suspense, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './home-route.module.css';

import { HydrationBanner, SyncChip } from '/@/renderer/cache';
import { useGridCarouselContainerQuery } from '/@/renderer/components/grid-carousel/grid-carousel-v2';
import { NativeScrollArea } from '/@/renderer/components/native-scroll-area/native-scroll-area';
import { AlbumInfiniteCarousel } from '/@/renderer/features/albums/components/album-infinite-carousel';
import { AlbumInfiniteFeatureCarousel } from '/@/renderer/features/home/components/album-infinite-feature-carousel';
import { FeatureCard } from '/@/renderer/features/home/components/feature-card/feature-card';
import { FeatureCardPicker } from '/@/renderer/features/home/components/feature-card/feature-card-picker';
import { FeaturedGenres } from '/@/renderer/features/home/components/featured-genres';
import { FeelingLuckyButton } from '/@/renderer/features/home/components/feeling-lucky-button';
import { LibraryStats } from '/@/renderer/features/home/components/library-stats';
import { NewSinceLastVisit } from '/@/renderer/features/home/components/new-since-last-visit';
import { QuickFilterChips } from '/@/renderer/features/home/components/quick-filter-chips';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { LibraryContainer } from '/@/renderer/features/shared/components/library-container';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { SongInfiniteCarousel } from '/@/renderer/features/songs/components/song-infinite-carousel';
import {
    HomeFeatureStyle,
    HomeItem,
    useCurrentServer,
    useHomeFeature,
    useHomeFeatureContent,
    useHomeFeatureStyle,
    useHomeFeelingLucky,
    useHomeItems,
    useWindowSettings,
} from '/@/renderer/store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import {
    AlbumListSort,
    LibraryItem,
    ServerType,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';
import { Platform } from '/@/shared/types/types';

const HomeRoute = () => {
    const { t } = useTranslation();
    const scrollAreaRef = useRef<HTMLDivElement>(null);
    const server = useCurrentServer();
    const { windowBarStyle } = useWindowSettings();
    const homeFeature = useHomeFeature();
    const homeFeatureContent = useHomeFeatureContent();
    const homeFeatureStyle = useHomeFeatureStyle();
    const homeFeelingLucky = useHomeFeelingLucky();
    const homeItems = useHomeItems();
    const containerQuery = useGridCarouselContainerQuery();

    const isJellyfin = server?.type === ServerType.JELLYFIN;

    const carousels = {
        [HomeItem.MOST_PLAYED]: {
            enableRefresh: true,
            itemType: isJellyfin ? LibraryItem.SONG : LibraryItem.ALBUM,
            sortBy: isJellyfin ? SongListSort.PLAY_COUNT : AlbumListSort.PLAY_COUNT,
            sortOrder: SortOrder.DESC,
            title: t('page.home.mostPlayed'),
        },
        [HomeItem.RANDOM]: {
            enableRefresh: true,
            itemType: LibraryItem.ALBUM,
            sortBy: AlbumListSort.RANDOM,
            sortOrder: SortOrder.ASC,
            title: t('page.home.explore'),
        },
        [HomeItem.RECENTLY_ADDED]: {
            enableRefresh: true,
            itemType: LibraryItem.ALBUM,
            sortBy: AlbumListSort.RECENTLY_ADDED,
            sortOrder: SortOrder.DESC,
            title: t('page.home.newlyAdded'),
        },
        [HomeItem.RECENTLY_PLAYED]: {
            enableRefresh: true,
            itemType: isJellyfin ? LibraryItem.SONG : LibraryItem.ALBUM,
            sortBy: isJellyfin ? SongListSort.RECENTLY_PLAYED : AlbumListSort.RECENTLY_PLAYED,
            sortOrder: SortOrder.DESC,
            title: t('page.home.recentlyPlayed'),
        },
        [HomeItem.RECENTLY_RELEASED]: {
            enableRefresh: true,
            itemType: LibraryItem.ALBUM,
            sortBy: AlbumListSort.RELEASE_DATE,
            sortOrder: SortOrder.DESC,
            title: t('page.home.recentlyReleased'),
        },
    };

    const sortedItems = homeItems.filter((item) => !item.disabled);

    const sortedCarousel = sortedItems
        .filter((item) => item.id !== HomeItem.GENRES)
        .map((item) => ({
            ...carousels[item.id],
            uniqueId: item.id,
        }));

    // Time-aware greeting at the top of the home page. Computed once per
    // render — the hour boundaries are coarse enough that "afternoon"
    // shifting to "evening" mid-session is fine without a timer.
    const hour = new Date().getHours();
    let greetingKey: 'afternoon' | 'evening' | 'morning' | 'night';
    if (hour < 5) greetingKey = 'night';
    else if (hour < 12) greetingKey = 'morning';
    else if (hour < 18) greetingKey = 'afternoon';
    else greetingKey = 'evening';
    const greeting = t(`page.home.greeting.${greetingKey}`);

    // Each rendered row knows its slot index so the CSS stagger lines up
    // with painted order, not the source order of the `if` branches above.
    // We compute the rows up-front, then `.map` them with a running index.
    const rows: ReactNode[] = [];

    if (homeFeature && homeFeatureStyle === HomeFeatureStyle.SINGLE) {
        rows.push(
            <ComponentErrorBoundary key="feature-single">
                <FeatureCardPicker />
                <FeatureCard variant={homeFeatureContent} />
            </ComponentErrorBoundary>,
        );
    }

    if (homeFeature && homeFeatureStyle === HomeFeatureStyle.MULTIPLE) {
        rows.push(
            <ComponentErrorBoundary key="feature-multiple">
                <AlbumInfiniteFeatureCarousel />
            </ComponentErrorBoundary>,
        );
    }

    if (homeFeelingLucky) {
        rows.push(
            <ComponentErrorBoundary key="feeling-lucky">
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <FeelingLuckyButton />
                </div>
            </ComponentErrorBoundary>,
        );
    }

    for (const item of sortedItems) {
        if (item.id === HomeItem.GENRES) {
            rows.push(
                <ComponentErrorBoundary key="featured-genres">
                    <FeaturedGenres />
                </ComponentErrorBoundary>,
            );
            continue;
        }

        if (item.id === HomeItem.LIBRARY_STATS) {
            rows.push(
                <ComponentErrorBoundary key="library-stats">
                    <LibraryStats />
                </ComponentErrorBoundary>,
            );
            continue;
        }

        if (item.id === HomeItem.QUICK_FILTERS) {
            rows.push(
                <ComponentErrorBoundary key="quick-filters">
                    <QuickFilterChips />
                </ComponentErrorBoundary>,
            );
            continue;
        }

        if (item.id === HomeItem.NEW_SINCE_LAST_VISIT) {
            rows.push(
                <ComponentErrorBoundary key="new-since-last-visit">
                    <NewSinceLastVisit />
                </ComponentErrorBoundary>,
            );
            continue;
        }

        const carousel = sortedCarousel.find((c) => c.uniqueId === item.id);
        if (!carousel) continue;

        const carouselKey = `carousel-${carousel.uniqueId}`;
        if (carousel.itemType === LibraryItem.ALBUM) {
            rows.push(
                <ComponentErrorBoundary key={carouselKey}>
                    <AlbumInfiniteCarousel
                        containerQuery={containerQuery}
                        enableRefresh={carousel.enableRefresh}
                        queryKey={['home', 'album', carousel.uniqueId] as const}
                        rowCount={1}
                        sortBy={carousel.sortBy as AlbumListSort}
                        sortOrder={carousel.sortOrder}
                        title={carousel.title}
                    />
                </ComponentErrorBoundary>,
            );
        } else if (carousel.itemType === LibraryItem.SONG) {
            rows.push(
                <ComponentErrorBoundary key={carouselKey}>
                    <SongInfiniteCarousel
                        containerQuery={containerQuery}
                        enableRefresh={carousel.enableRefresh}
                        queryKey={['home', 'song', carousel.uniqueId] as const}
                        rowCount={1}
                        sortBy={carousel.sortBy as SongListSort}
                        sortOrder={carousel.sortOrder}
                        title={carousel.title}
                    />
                </ComponentErrorBoundary>,
            );
        }
    }

    // Slot the greeting at the very top so it leads the staggered fade-in.
    rows.unshift(
        <div className={styles.greeting} key="greeting">
            <Text className={styles.greetingText}>{greeting}</Text>
        </div>,
    );

    return (
        <AnimatedPage>
            <NativeScrollArea
                pageHeaderProps={{
                    backgroundColor: 'var(--theme-colors-background)',
                    children: (
                        <LibraryHeaderBar>
                            <LibraryHeaderBar.Title>{t('page.home.title')}</LibraryHeaderBar.Title>
                            <SyncChip />
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
                        pt={windowBarStyle === Platform.WEB ? '5rem' : '3rem'}
                        ref={containerQuery.ref}
                    >
                        <HydrationBanner />
                        {/* SyncChip is also mounted in the page-header chrome
                            above, but that chrome only fades in after the user
                            scrolls past the 200px offset. While sitting at the
                            top of home during the initial hydration the user
                            wouldn't see it; render a second copy here so the
                            sync progress is glanceable from the entry point.
                            The chip self-gates on enabled + active sweep so
                            both mounts are no-ops outside that window. */}
                        <SyncChip />
                        {/* Per-widget error boundaries so a thrown error in one
                            widget (e.g. a transient malformed-response from a
                            specific carousel) doesn't black-hole the entire
                            home page via PageErrorBoundary below. Each widget
                            gets its own boundary; the rest keep rendering. */}
                        {rows.map((row, index) => (
                            <HomeRow
                                index={index}
                                // The row already carries a stable React key
                                // because each ComponentErrorBoundary above is
                                // keyed; reuse it on the wrapper so the
                                // animation also keys consistently.
                                key={(row as { key?: string }).key ?? `home-row-${index}`}
                            >
                                {row}
                            </HomeRow>
                        ))}
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
 */
const HomeRow = ({ children, index }: { children: ReactNode; index: number }) => {
    const style: CSSProperties = { animationDelay: `${index * 80}ms` };
    return (
        <div className={styles.row} style={style}>
            {children}
        </div>
    );
};

const HomeRouteWithBoundary = () => {
    return (
        <PageErrorBoundary>
            <Suspense fallback={<Spinner container />}>
                <HomeRoute />
            </Suspense>
        </PageErrorBoundary>
    );
};

export default HomeRouteWithBoundary;
