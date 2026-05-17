import { Suspense, useRef } from 'react';
import { useTranslation } from 'react-i18next';

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

    return (
        <AnimatedPage>
            <NativeScrollArea
                pageHeaderProps={{
                    backgroundColor: 'var(--theme-colors-background)',
                    children: (
                        <LibraryHeaderBar>
                            <LibraryHeaderBar.Title>{t('page.home.title')}</LibraryHeaderBar.Title>
                        </LibraryHeaderBar>
                    ),
                    offset: 200,
                }}
                ref={scrollAreaRef}
                scrollKey="home"
            >
                <LibraryContainer>
                    <Stack
                        gap="2xl"
                        mb="5rem"
                        pt={windowBarStyle === Platform.WEB ? '5rem' : '3rem'}
                        px="2rem"
                        ref={containerQuery.ref}
                    >
                        {/* Per-widget error boundaries so a thrown error in one
                            widget (e.g. a transient malformed-response from a
                            specific carousel) doesn't black-hole the entire
                            home page via PageErrorBoundary below. Each widget
                            gets its own boundary; the rest keep rendering. */}
                        {homeFeature && homeFeatureStyle === HomeFeatureStyle.SINGLE && (
                            <ComponentErrorBoundary>
                                <FeatureCardPicker />
                                <FeatureCard variant={homeFeatureContent} />
                            </ComponentErrorBoundary>
                        )}
                        {homeFeature && homeFeatureStyle === HomeFeatureStyle.MULTIPLE && (
                            <ComponentErrorBoundary>
                                <AlbumInfiniteFeatureCarousel />
                            </ComponentErrorBoundary>
                        )}
                        {homeFeelingLucky && (
                            <ComponentErrorBoundary>
                                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                                    <FeelingLuckyButton />
                                </div>
                            </ComponentErrorBoundary>
                        )}
                        {sortedItems.map((item) => {
                            if (item.id === HomeItem.GENRES) {
                                return (
                                    <ComponentErrorBoundary key="featured-genres">
                                        <FeaturedGenres />
                                    </ComponentErrorBoundary>
                                );
                            }

                            if (item.id === HomeItem.LIBRARY_STATS) {
                                return (
                                    <ComponentErrorBoundary key="library-stats">
                                        <LibraryStats />
                                    </ComponentErrorBoundary>
                                );
                            }

                            if (item.id === HomeItem.QUICK_FILTERS) {
                                return (
                                    <ComponentErrorBoundary key="quick-filters">
                                        <QuickFilterChips />
                                    </ComponentErrorBoundary>
                                );
                            }

                            if (item.id === HomeItem.NEW_SINCE_LAST_VISIT) {
                                return (
                                    <ComponentErrorBoundary key="new-since-last-visit">
                                        <NewSinceLastVisit />
                                    </ComponentErrorBoundary>
                                );
                            }

                            const carousel = sortedCarousel.find((c) => c.uniqueId === item.id);
                            if (!carousel) {
                                return null;
                            }

                            const carouselKey = `carousel-${carousel.uniqueId}`;
                            if (carousel.itemType === LibraryItem.ALBUM) {
                                return (
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
                                    </ComponentErrorBoundary>
                                );
                            }

                            if (carousel.itemType === LibraryItem.SONG) {
                                return (
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
                                    </ComponentErrorBoundary>
                                );
                            }

                            return null;
                        })}
                    </Stack>
                </LibraryContainer>
            </NativeScrollArea>
        </AnimatedPage>
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
