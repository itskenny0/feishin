import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { AlbumInfiniteSingleFeatureCarousel } from '/@/renderer/features/home/components/album-infinite-single-feature-carousel';
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

const ShellFeatureCard = ({ variant }: { variant: FeatureCardVariant }) => {
    const data = useFeatureDataForVariant(variant);
    if (!data) return null;
    return <FeatureCardShell data={data} />;
};

const SurpriseMeFeatureCard = () => {
    const [poolIdx, setPoolIdx] = useState(() => Math.floor(Math.random() * SURPRISE_POOL.length));

    useEffect(() => {
        const id = window.setInterval(() => {
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
    return <ShellFeatureCard variant={subVariant} />;
};

export const FeatureCard = ({ variant }: { variant: FeatureCardVariant }) => {
    if (variant === 'album') return <AlbumInfiniteSingleFeatureCarousel />;
    if (variant === 'albumOfTheDay') {
        // Placeholder — albumOfTheDay variant uses a single-cover layout that
        // doesn't fit the 2×5 grid shell. To be replaced by a dedicated
        // component (Task #51). For now, fall back to the album banner so the
        // option doesn't render an empty card if a user picks it.
        return <AlbumInfiniteSingleFeatureCarousel />;
    }
    if (variant === 'surpriseMe') return <SurpriseMeFeatureCard />;
    return <ShellFeatureCard variant={variant} />;
};
