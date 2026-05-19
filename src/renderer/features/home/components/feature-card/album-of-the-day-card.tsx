import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './album-of-the-day-card.module.css';

import { api } from '/@/renderer/api';
import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Album, AlbumListSort, LibraryItem, SortOrder } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

/**
 * Deterministic 24h-stable random album. The seed combines the serverId and
 * today's date string, so the pick is the same all day for a given user but
 * differs across users and across days.
 */
const CANDIDATE_POOL_SIZE = 200;

const hashStringToInt = (s: string): number => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i += 1) {
        h ^= s.charCodeAt(i);
        h = (h * 16777619) >>> 0;
    }
    return h;
};

/**
 * YYYY-MM-DD in the user's LOCAL timezone. Previous implementation used
 * `new Date().toISOString().slice(0,10)` which is UTC — a US-Pacific user
 * would see the album-of-the-day flip at 4 PM local. Using local means the
 * rollover happens at the user's actual midnight.
 */
const localDateKey = (): string => {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
};

const useAlbumOfTheDayCandidates = (serverId: string | undefined, dateKey: string) =>
    useQuery({
        enabled: Boolean(serverId),
        gcTime: 1000 * 60 * 60 * 24,
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as Album[];
            const res = await api.controller.getAlbumList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: CANDIDATE_POOL_SIZE,
                    sortBy: AlbumListSort.RANDOM,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            const items = (res?.items ?? []) as Album[];
            // Prefer albums with covers (they look great in the big-cover
            // layout) but fall back to the full pool if the library doesn't
            // have any cover art — otherwise the card would stay stuck on
            // skeleton forever for libraries without images.
            const withImage = items.filter((a) => Boolean(a.imageId));
            return withImage.length > 0 ? withImage : items;
        },
        // staleTime 24h so we don't re-roll mid-day; the candidate pool is
        // refreshed on the next calendar day either way (via the queryKey
        // including the date string).
        queryKey: ['feature-card-album-of-the-day-pool', serverId ?? '', dateKey] as const,
        staleTime: 1000 * 60 * 60 * 24,
    });

/**
 * Tracks the local date key and re-renders consumers when midnight crosses,
 * so a session that stays open past midnight rolls over to the next day's
 * pick without needing a manual reload.
 */
const useLocalDateKey = (): string => {
    const [date, setDate] = useState(localDateKey);
    useEffect(() => {
        // Sample every minute. Cheap; ensures the rollover happens within a
        // minute of local midnight rather than waiting for the next render.
        const interval = setInterval(() => {
            const now = localDateKey();
            setDate((prev) => (prev === now ? prev : now));
        }, 60_000);
        return () => clearInterval(interval);
    }, []);
    return date;
};

export const AlbumOfTheDayCard = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const serverId = server?.id;
    const { addToQueueByData } = usePlayer();

    const today = useLocalDateKey();
    const { data: candidates, isLoading: candidatesLoading } = useAlbumOfTheDayCandidates(
        serverId,
        today,
    );

    const featured = useMemo<Album | null>(() => {
        if (!candidates || candidates.length === 0) return null;
        const seed = hashStringToInt(`${serverId ?? ''}:${today}`);
        return candidates[seed % candidates.length];
    }, [candidates, serverId, today]);

    // Fetch the full album detail (with tracks) for the featured album so we
    // can offer Play without an additional click.
    const { data: detail, isLoading: detailLoading } = useQuery({
        ...albumQueries.detail({
            query: { id: featured?.id ?? '' },
            serverId: serverId ?? '',
        }),
        enabled: Boolean(featured && serverId),
    });

    const imageUrl = useItemImageUrl({
        id: featured?.imageId || undefined,
        imageUrl: featured?.imageUrl || undefined,
        itemType: LibraryItem.ALBUM,
        type: 'itemCard',
    });

    const handlePlay = useCallback(() => {
        const songs = detail?.songs ?? [];
        if (songs.length === 0) return;
        addToQueueByData(songs, Play.NOW);
    }, [addToQueueByData, detail?.songs]);

    const albumPath = useMemo(() => {
        if (!featured) return null;
        return generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: featured.id });
    }, [featured]);

    const artistPath = useMemo(() => {
        const primary = featured?.albumArtists?.[0] ?? featured?.artists?.[0];
        if (!primary?.id) return null;
        return generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
            albumArtistId: primary.id,
        });
    }, [featured]);

    const showSkeleton = candidatesLoading || (featured && !detail && detailLoading);
    const isEmpty = !candidatesLoading && (candidates ?? []).length === 0;

    return (
        <div className={styles.card}>
            <div
                aria-hidden
                className={styles.blurredBackground}
                style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}
            />
            <div aria-hidden className={styles.scrim} />
            <div className={styles.content}>
                {isEmpty ? (
                    <Skeleton
                        borderRadius="var(--theme-radius-md)"
                        containerClassName={styles.skeletonCover}
                    />
                ) : showSkeleton || !featured ? (
                    <Skeleton
                        borderRadius="var(--theme-radius-md)"
                        containerClassName={styles.skeletonCover}
                    />
                ) : (
                    <Link
                        aria-label={featured.name}
                        className={styles.coverLink}
                        to={albumPath ?? '#'}
                    >
                        <div className={styles.coverWrap}>
                            {imageUrl ? (
                                <img
                                    alt=""
                                    className={styles.coverImg}
                                    loading="lazy"
                                    src={imageUrl}
                                />
                            ) : (
                                <div className={styles.coverImg} />
                            )}
                        </div>
                    </Link>
                )}
                <div className={styles.infoPane}>
                    <span className={styles.eyebrow}>
                        {t('page.home.featureAlbumOfTheDay_eyebrow')}
                    </span>
                    {featured && albumPath ? (
                        <Link className={styles.title} to={albumPath}>
                            {featured.name}
                        </Link>
                    ) : (
                        <span className={styles.title}>
                            {isEmpty
                                ? t('page.home.featureAlbumOfTheDay_empty')
                                : (featured?.name ?? '…')}
                        </span>
                    )}
                    <span className={styles.subtitle}>
                        {isEmpty ? (
                            t('page.home.featureAlbumOfTheDay_empty_subtitle')
                        ) : featured ? (
                            <>
                                {artistPath ? (
                                    <Link className={styles.subtitleLink} to={artistPath}>
                                        {featured.albumArtistName ||
                                            featured.albumArtists?.[0]?.name ||
                                            featured.artists?.[0]?.name ||
                                            ''}
                                    </Link>
                                ) : (
                                    featured.albumArtistName
                                )}
                                {featured.releaseYear ? ` · ${featured.releaseYear}` : ''}
                                {featured.songCount
                                    ? ` · ${t('page.home.featureAlbumOfTheDay_trackCount', {
                                          count: featured.songCount,
                                      })}`
                                    : ''}
                            </>
                        ) : (
                            t('page.home.featureAlbumOfTheDay_loading')
                        )}
                    </span>
                    <div className={styles.actions}>
                        <Button
                            disabled={!detail?.songs || detail.songs.length === 0}
                            leftSection={<Icon icon="mediaPlay" />}
                            onClick={handlePlay}
                            variant="filled"
                        >
                            {t('page.home.featureAlbumOfTheDay_play')}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
};
