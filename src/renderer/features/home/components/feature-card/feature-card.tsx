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
import { FeatureCardShell } from '/@/renderer/features/home/components/feature-card/feature-card-shell';
import { isFeatureCardHovered } from '/@/renderer/features/home/components/feature-card/hover-signal';
import { useCurrentServer } from '/@/renderer/store';
import { useHomeFeatureCardRotationIntervalSeconds } from '/@/renderer/store/settings.store';

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
 *
 * Some variants (currently just `unplayed`) rely on Jellyfin-only filters and
 * would surface a useless "unsupported" empty card on other server types —
 * we filter them out of the rotator below per `currentServer.type`.
 */
const SURPRISE_POOL_BASE: FeatureCardVariant[] = [
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

const JELLYFIN_ONLY_VARIANTS: ReadonlySet<FeatureCardVariant> = new Set(['unplayed']);

interface ShellWrapperProps {
    cornerBadge?: string;
    hideRotationDots?: boolean;
}

/*
 * Per-variant thin wrappers: each calls *exactly one* data hook so that
 * switching variants tears down the previous variant's queries (good for
 * memory, query cache discipline, and avoiding "doesn't load" symptoms when
 * one variant's data path misbehaves).
 *
 * Before this split, a single `useFeatureDataForVariant` called all 9 hooks
 * unconditionally to satisfy the rules of hooks — every home-page mount
 * kicked off 9 server requests and re-rendered on each of their updates.
 */

const ArtistVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useArtistFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const GenreVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const data = useGenreFeatureData(server?.id, server?.type, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const RecentlyPlayedVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useRecentlyPlayedFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const TopPlayedVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useTopPlayedFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const FavoritesVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useFavoritesFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const UnplayedVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const data = useUnplayedFeatureData(server?.id, server?.type, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const ForgottenFavoritesVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useForgottenFavoritesFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const TimeMachineVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useTimeMachineFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const DecadeVariant = ({ cornerBadge, hideRotationDots }: ShellWrapperProps) => {
    const { t } = useTranslation();
    const serverId = useCurrentServer()?.id;
    const data = useDecadeDiveFeatureData(serverId, t);
    return (
        <FeatureCardShell
            cornerBadge={cornerBadge}
            data={data}
            hideRotationDots={hideRotationDots}
        />
    );
};

const ShellVariantSwitch = ({
    cornerBadge,
    hideRotationDots,
    variant,
}: ShellWrapperProps & { variant: FeatureCardVariant }) => {
    switch (variant) {
        case 'artist':
            return <ArtistVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />;
        case 'decade':
            return <DecadeVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />;
        case 'favorites':
            return (
                <FavoritesVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />
            );
        case 'forgottenFavorites':
            return (
                <ForgottenFavoritesVariant
                    cornerBadge={cornerBadge}
                    hideRotationDots={hideRotationDots}
                />
            );
        case 'genre':
            return <GenreVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />;
        case 'recentlyPlayed':
            return (
                <RecentlyPlayedVariant
                    cornerBadge={cornerBadge}
                    hideRotationDots={hideRotationDots}
                />
            );
        case 'timeMachine':
            return (
                <TimeMachineVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />
            );
        case 'topPlayed':
            return (
                <TopPlayedVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />
            );
        case 'unplayed':
            return (
                <UnplayedVariant cornerBadge={cornerBadge} hideRotationDots={hideRotationDots} />
            );
        default:
            return null;
    }
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
    const serverType = useCurrentServer()?.type;
    const rotateIntervalMs = useHomeFeatureCardRotationIntervalSeconds() * 1000;
    const pool = useMemo(
        () =>
            SURPRISE_POOL_BASE.filter((v) => {
                if (!JELLYFIN_ONLY_VARIANTS.has(v)) return true;
                return serverType === 'jellyfin';
            }),
        [serverType],
    );
    const [poolIdx, setPoolIdx] = useState(() => Math.floor(Math.random() * pool.length));

    useEffect(() => {
        const id = window.setInterval(() => {
            // The shell's hover signal pauses inner-variant rotation, but this
            // outer cycle is its own loop — check the same signal so hovering
            // freezes the entire chain.
            if (isFeatureCardHovered()) return;
            setPoolIdx((prev) => {
                if (pool.length <= 1) return prev;
                let next = Math.floor(Math.random() * pool.length);
                if (next === prev) next = (next + 1) % pool.length;
                return next;
            });
        }, rotateIntervalMs);
        return () => window.clearInterval(id);
    }, [pool.length, rotateIntervalMs]);

    const subVariant = useMemo(
        () => pool[poolIdx % Math.max(pool.length, 1)] ?? pool[0] ?? 'artist',
        [poolIdx, pool],
    );
    const badge = `🎲 ${t(`page.home.${SURPRISE_BADGE_LABELS[subVariant]}`)}`;
    return <ShellVariantSwitch cornerBadge={badge} hideRotationDots variant={subVariant} />;
};

export const FeatureCard = ({ variant }: { variant: FeatureCardVariant }) => {
    if (variant === 'album') return <AlbumInfiniteSingleFeatureCarousel />;
    if (variant === 'albumOfTheDay') return <AlbumOfTheDayCard />;
    if (variant === 'surpriseMe') return <SurpriseMeFeatureCard />;
    return <ShellVariantSwitch variant={variant} />;
};
