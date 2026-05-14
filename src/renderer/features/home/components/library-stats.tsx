import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './library-stats.module.css';

import { api } from '/@/renderer/api';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer } from '/@/renderer/store';
import {
    AlbumArtistListSort,
    AlbumListSort,
    GenreListSort,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

/**
 * Compact home-page widget showing the user's library size at a glance. Calls
 * the *Count endpoints (which Jellyfin returns alongside list queries via
 * limit=1) so the cost is one tiny request per metric.
 */

const formatCount = (n: null | number | undefined): string => {
    if (n === null || n === undefined) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
    return String(n);
};

const useCounts = (serverId: string | undefined) => {
    const tracks = useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return 0;
            return api.controller.getSongListCount({
                apiClientProps: { serverId, signal },
                query: {
                    sortBy: SongListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
            });
        },
        queryKey: ['library-stats', 'tracks', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });
    const albums = useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return 0;
            return api.controller.getAlbumListCount({
                apiClientProps: { serverId, signal },
                query: {
                    sortBy: AlbumListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
            });
        },
        queryKey: ['library-stats', 'albums', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });
    const artists = useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return 0;
            return api.controller.getAlbumArtistListCount({
                apiClientProps: { serverId, signal },
                query: {
                    sortBy: AlbumArtistListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
            });
        },
        queryKey: ['library-stats', 'artists', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });
    const genres = useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return 0;
            // The genre list endpoint returns TotalRecordCount on the page
            // itself, so we ask for one record and read totalRecordCount off
            // the response.
            const res = await api.controller.getGenreList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: 1,
                    sortBy: GenreListSort.NAME,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
            });
            return res?.totalRecordCount ?? 0;
        },
        queryKey: ['library-stats', 'genres', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });

    return { albums, artists, genres, tracks };
};

interface TileProps {
    label: string;
    loading?: boolean;
    sub?: string;
    to?: string;
    value: string;
}

const Tile = ({ label, loading, sub, to, value }: TileProps) => {
    const inner = (
        <>
            <span className={styles.tileLabel}>{label}</span>
            <span className={`${styles.tileValue}${loading ? ` ${styles.loading}` : ''}`}>
                {loading ? '' : value}
            </span>
            {sub && <span className={styles.tileSub}>{sub}</span>}
        </>
    );
    if (to) {
        return (
            <Link className={`${styles.tile} ${styles.tileLink}`} to={to}>
                {inner}
            </Link>
        );
    }
    return <div className={styles.tile}>{inner}</div>;
};

export const LibraryStats = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const serverId = server?.id;
    const counts = useCounts(serverId);

    const tilesData = useMemo(
        () => [
            {
                label: t('page.home.libraryStats_tracks'),
                loading: counts.tracks.isLoading,
                to: AppRoute.LIBRARY_SONGS,
                value: formatCount(counts.tracks.data),
            },
            {
                label: t('page.home.libraryStats_albums'),
                loading: counts.albums.isLoading,
                to: AppRoute.LIBRARY_ALBUMS,
                value: formatCount(counts.albums.data),
            },
            {
                label: t('page.home.libraryStats_artists'),
                loading: counts.artists.isLoading,
                to: AppRoute.LIBRARY_ALBUM_ARTISTS,
                value: formatCount(counts.artists.data),
            },
            {
                label: t('page.home.libraryStats_genres'),
                loading: counts.genres.isLoading,
                to: AppRoute.LIBRARY_GENRES,
                value: formatCount(counts.genres.data),
            },
        ],
        [counts, t],
    );

    return (
        <section className={styles.section}>
            <h2 className={styles.header}>{t('page.home.libraryStats_title')}</h2>
            <div className={styles.grid}>
                {tilesData.map((tile) => (
                    <Tile
                        key={tile.label}
                        label={tile.label}
                        loading={tile.loading}
                        to={tile.to}
                        value={tile.value}
                    />
                ))}
            </div>
        </section>
    );
};
