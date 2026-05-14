import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AlbumInfiniteSingleFeatureCarousel } from '/@/renderer/features/home/components/album-infinite-single-feature-carousel';
import { AlbumOfTheDayCard } from '/@/renderer/features/home/components/feature-card/album-of-the-day-card';
import {
    useArtistFeatureData,
    useDecadeDiveFeatureData,
    useFavoritesFeatureData,
    useForgottenFavoritesFeatureData,
    useGenreFeatureData,
    useRecentlyPlayedFeatureData,
    useTimeMachineFeatureData,
    useTopPlayedFeatureData,
    useUnplayedFeatureData,
} from '/@/renderer/features/home/components/feature-card/data-hooks';
import {
    FeatureCardData,
    FeatureCardShell,
    ROTATE_INTERVAL_MS,
} from '/@/renderer/features/home/components/feature-card/feature-card-shell';
import { isFeatureCardHovered } from '/@/renderer/features/home/components/feature-card/hover-signal';
import { useCurrentServer } from '/@/renderer/store';

export type FeatureCardVariant =
    | 'album'
    | 'albumOfTheDay'
    | 'artist'
    | 'decade'
    | 'favorites'
    | 'forgottenFavorites'
    | 'genre'
    | 'recentlyPlayed'
    | 'surpriseMe'
    | 'timeMachine'
    | 'topPlayed'
    | 'unplayed';

/**
 * Variants used by the "Surprise me" rotator. `album` and `albumOfTheDay` are
 * intentionally excluded because they render with a different layout that the
 * generic shell wouldn't fit cleanly.
 */
const SURPRISE_POOL: FeatureCardVariant[] = [
    'artist',
    'genre',
    'recentlyPlayed',
    'topPlayed',
    'favorites',
    'unplayed',
    'forgottenFavorites',
    'timeMachine',
    'decade',
];

const useFeatureDataForVariant = (variant: FeatureCardVariant): FeatureCardData | null => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const serverId = server?.id;
    const serverType = server?.type;

    // Every hook is called unconditionally to satisfy the rules of hooks; only
    // the matching variant's data is returned.
    const artist = useArtistFeatureData(serverId, t);
    const genre = useGenreFeatureData(serverId, serverType, t);
    const recentlyPlayed = useRecentlyPlayedFeatureData(serverId, t);
    const topPlayed = useTopPlayedFeatureData(serverId, t);
    const favorites = useFavoritesFeatureData(serverId, t);
    const unplayed = useUnplayedFeatureData(serverId, t);
    const forgotten = useForgottenFavoritesFeatureData(serverId, t);
    const timeMachine = useTimeMachineFeatureData(serverId, t);
    const decade = useDecadeDiveFeatureData(serverId, t);

    switch (variant) {
        case 'artist':
            return artist;
        case 'decade':
            return decade;
        case 'favorites':
            return favorites;
        case 'forgottenFavorites':
            return forgotten;
        case 'genre':
            return genre;
        case 'recentlyPlayed':
            return recentlyPlayed;
        case 'timeMachine':
            return timeMachine;
        case 'topPlayed':
            return topPlayed;
        case 'unplayed':
            return unplayed;
        default:
            return null;
    }
};

const ShellFeatureCard = ({
    cornerBadge,
    hideRotationDots,
    variant,
}: {
    cornerBadge?: string;
    hideRotationDots?: boolean;
    variant: FeatureCardVariant;
}) => {
    const data = useFeatureDataForVariant(variant);
    if (!data) return null;
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const SURPRISE_BADGE_LABELS: Record<FeatureCardVariant, string> = {
    album: 'featureVariant_album',
    albumOfTheDay: 'featureVariant_albumOfTheDay',
    artist: 'featureVariant_artist',
    decade: 'featureVariant_decade',
    favorites: 'featureVariant_favorites',
    forgottenFavorites: 'featureVariant_forgottenFavorites',
    genre: 'featureVariant_genre',
    recentlyPlayed: 'featureVariant_recentlyPlayed',
    surpriseMe: 'featureVariant_surpriseMe',
    timeMachine: 'featureVariant_timeMachine',
    topPlayed: 'featureVariant_topPlayed',
    unplayed: 'featureVariant_unplayed',
};

const SurpriseMeFeatureCard = () => {
    const { t } = useTranslation();
    const [poolIdx, setPoolIdx] = useState(() => Math.floor(Math.random() * SURPRISE_POOL.length));

    useEffect(() => {
        const id = window.setInterval(() => {
            // The shell's hover signal pauses inner-variant rotation, but this
            // outer cycle is its own loop — check the same signal so hovering
            // freezes the entire chain.
            if (isFeatureCardHovered()) return;
            setPoolIdx((prev) => {
                if (SURPRISE_POOL.length <= 1) return prev;
                let next = Math.floor(Math.random() * SURPRISE_POOL.length);
                if (next === prev) next = (next + 1) % SURPRISE_POOL.length;
                return next;
            });
        }, ROTATE_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, []);

    const subVariant = useMemo(() => SURPRISE_POOL[poolIdx % SURPRISE_POOL.length], [poolIdx]);
    const badge = `🎲 ${t(`page.home.${SURPRISE_BADGE_LABELS[subVariant]}`)}`;
    return <ShellFeatureCard cornerBadge={badge} hideRotationDots variant={subVariant} />;
};

export const FeatureCard = ({ variant }: { variant: FeatureCardVariant }) => {
    if (variant === 'album') return <AlbumInfiniteSingleFeatureCarousel />;
    if (variant === 'albumOfTheDay') return <AlbumOfTheDayCard />;
    if (variant === 'surpriseMe') return <SurpriseMeFeatureCard />;
    return <ShellFeatureCard variant={variant} />;
};
