import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
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

const useAlbumOfTheDayCandidates = (serverId: string | undefined) =>
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
            return (res?.items ?? []).filter((a: Album) => Boolean(a.imageId));
        },
        // staleTime 24h so we don't re-roll mid-day; the candidate pool is
        // refreshed on the next calendar day either way (via the queryKey
        // including the date string).
        queryKey: [
            'feature-card-album-of-the-day-pool',
            serverId ?? '',
            new Date().toISOString().slice(0, 10),
        ] as const,
        staleTime: 1000 * 60 * 60 * 24,
    });

interface AlbumOfTheDayCardProps {
    /** If true, hide the "Play album" button — used inside Surprise me to avoid
     *  duplicating UI conventions across variants. */
    compact?: boolean;
}

export const AlbumOfTheDayCard = ({ compact = false }: AlbumOfTheDayCardProps) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const serverId = server?.id;
    const { addToQueueByData } = usePlayer();

    const { data: candidates, isLoading: candidatesLoading } = useAlbumOfTheDayCandidates(serverId);

    const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

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

    return (
        <div className={styles.card}>
            <div
                aria-hidden
                className={styles.blurredBackground}
                style={imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined}
            />
            <div aria-hidden className={styles.scrim} />
            <div className={styles.content}>
                {showSkeleton || !featured ? (
                    <div className={styles.skeletonCover} />
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
                        <span className={styles.title}>{featured?.name ?? '…'}</span>
                    )}
                    <span className={styles.subtitle}>
                        {featured ? (
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
                    {!compact && (
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
                    )}
                </div>
            </div>
        </div>
    );
};
