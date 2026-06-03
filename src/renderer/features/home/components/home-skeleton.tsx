import { memo } from 'react';

import styles from './home-skeleton.module.css';

import { Skeleton } from '/@/shared/components/skeleton/skeleton';

/**
 * Layout-shaped skeletons for the home page.
 *
 * The home shell (header bar, greeting, section frames) renders synchronously
 * because its top-level hooks are non-suspending Zustand reads. Only the
 * data-driven sections suspend, so these skeletons are used as:
 *
 *   - per-section Suspense fallbacks inside `home-route.tsx` (feature banner,
 *     genre grid), so each section fills in independently instead of one
 *     spinner gating the whole page, and
 *   - the route-level Suspense fallback (`HomeSkeleton`) so even the lazy
 *     route-chunk load paints a shaped skeleton rather than a centered spinner.
 *
 * Every placeholder is height-matched to its real counterpart so content swaps
 * in place with no layout shift.
 *
 * Wired as the route-level fallback by importing `HomeSkeleton` from
 * `/@/renderer/features/home/components/home-skeleton`.
 */

const SKELETON_RADIUS = 'var(--theme-radius-md)';
const SKELETON_RADIUS_SM = 'var(--theme-radius-sm)';

/**
 * Banner-shaped fallback for the feature card / feature carousel (the
 * `FeatureCard`, `AlbumInfiniteFeatureCarousel`, and
 * `AlbumInfiniteSingleFeatureCarousel` slots). Matches their 280–300px height.
 */
export const FeatureCardSkeleton = memo(() => {
    return (
        <Skeleton borderRadius={SKELETON_RADIUS} className={styles.featureCard} enableAnimation />
    );
});

FeatureCardSkeleton.displayName = 'FeatureCardSkeleton';

interface CarouselRowSkeletonProps {
    cardCount?: number;
}

/**
 * Single carousel-row fallback: a title strip plus a row of poster-shaped
 * placeholder cards. Used inside the full-layout `HomeSkeleton`; the live
 * album/song carousels keep their own `GridCarouselSkeletonFallback`.
 */
export const CarouselRowSkeleton = memo(({ cardCount = 6 }: CarouselRowSkeletonProps) => {
    return (
        <div className={styles.carouselRow}>
            <Skeleton borderRadius={SKELETON_RADIUS_SM} enableAnimation height={24} width="35%" />
            <div className={styles.carouselCards}>
                {Array.from({ length: cardCount }).map((_, index) => (
                    <div className={styles.posterCard} key={index}>
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            className={styles.posterImage}
                            enableAnimation
                        />
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            enableAnimation
                            height={14}
                            width="80%"
                        />
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            enableAnimation
                            height={12}
                            width="55%"
                        />
                    </div>
                ))}
            </div>
        </div>
    );
});

CarouselRowSkeleton.displayName = 'CarouselRowSkeleton';

interface GenreGridSkeletonProps {
    tileCount?: number;
}

/**
 * Title strip + tile grid fallback for `FeaturedGenres`. Tile dimensions mirror
 * `featured-genres.module.css` (min-height 4.25rem, 220px min column).
 */
export const GenreGridSkeleton = memo(({ tileCount = 12 }: GenreGridSkeletonProps) => {
    return (
        <div className={styles.genreSection}>
            <Skeleton borderRadius={SKELETON_RADIUS_SM} enableAnimation height={24} width="25%" />
            <div className={styles.genreGrid}>
                {Array.from({ length: tileCount }).map((_, index) => (
                    <Skeleton
                        borderRadius={SKELETON_RADIUS}
                        enableAnimation
                        height="4.25rem"
                        key={index}
                    />
                ))}
            </div>
        </div>
    );
});

GenreGridSkeleton.displayName = 'GenreGridSkeleton';

interface HomeSkeletonProps {
    carouselCount?: number;
}

/**
 * Full-layout home skeleton: greeting + feature banner + a few carousel rows.
 * Suitable as the route-level Suspense fallback (replaces `<Spinner container />`).
 */
export const HomeSkeleton = memo(({ carouselCount = 4 }: HomeSkeletonProps) => {
    return (
        <div className={styles.skeletonStack} role="presentation">
            <div className={styles.greeting}>
                <Skeleton
                    borderRadius={SKELETON_RADIUS_SM}
                    enableAnimation
                    height="2.5rem"
                    width="45%"
                />
            </div>
            <FeatureCardSkeleton />
            {Array.from({ length: carouselCount }).map((_, index) => (
                <CarouselRowSkeleton key={index} />
            ))}
        </div>
    );
});

HomeSkeleton.displayName = 'HomeSkeleton';
