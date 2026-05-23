import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './library-stats.module.css';

import { api } from '/@/renderer/api';
import { getActiveCacheDb, isCacheAvailableSync, readSnapshot, writeSnapshot } from '/@/renderer/cache';
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

/**
 * Locale-aware compact formatting. 12_345 → "12K" in en-US, "12 K" in
 * fr-FR, "1,2万" in ja-JP, etc. Falls back to plain string conversion if
 * the runtime doesn't support `notation: 'compact'`.
 */
const formatCount = (n: null | number | undefined, locale: string): string => {
    if (n === null || n === undefined) return '—';
    try {
        return new Intl.NumberFormat(locale, {
            compactDisplay: 'short',
            maximumFractionDigits: 1,
            notation: 'compact',
        }).format(n);
    } catch {
        return String(n);
    }
};

// Cache-first counts. When the active Dexie cache holds rows of an entity
// type, return the Dexie count immediately (the unfiltered count is just
// `.count()` against the table), then revalidate against the server. The
// snapshot map persists the last fetched count across reloads so the tile
// paints with a number before the network round-trip lands.
const cachedCount = async (entity: 'albums' | 'artists' | 'genres' | 'songs'): Promise<number | undefined> => {
    if (!isCacheAvailableSync()) return undefined;
    const db = getActiveCacheDb();
    if (!db) return undefined;
    try {
        if (entity === 'songs') return await db.songs.count();
        if (entity === 'albums') return await db.albums.count();
        if (entity === 'artists') {
            return await db.artists.where('Kind').equals('AlbumArtist').count();
        }
        return await db.genres.count();
    } catch {
        return undefined;
    }
};

const useCounts = (serverId: string | undefined) => {
    const tracks = useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<number>(['library-stats', 'tracks', serverId ?? ''])) as never,
        queryFn: async ({ signal }) => {
            const key = ['library-stats', 'tracks', serverId ?? ''] as const;
            if (!serverId) return 0;
            const cached = await cachedCount('songs');
            if (cached !== undefined && cached > 0) writeSnapshot(key, cached);
            const fresh = await api.controller.getSongListCount({
                apiClientProps: { serverId, signal },
                query: {
                    sortBy: SongListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
            });
            writeSnapshot(key, fresh);
            return fresh;
        },
        queryKey: ['library-stats', 'tracks', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });
    const albums = useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<number>(['library-stats', 'albums', serverId ?? ''])) as never,
        queryFn: async ({ signal }) => {
            const key = ['library-stats', 'albums', serverId ?? ''] as const;
            if (!serverId) return 0;
            const cached = await cachedCount('albums');
            if (cached !== undefined && cached > 0) writeSnapshot(key, cached);
            const fresh = await api.controller.getAlbumListCount({
                apiClientProps: { serverId, signal },
                query: {
                    sortBy: AlbumListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
            });
            writeSnapshot(key, fresh);
            return fresh;
        },
        queryKey: ['library-stats', 'albums', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });
    const artists = useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<number>(['library-stats', 'artists', serverId ?? ''])) as never,
        queryFn: async ({ signal }) => {
            const key = ['library-stats', 'artists', serverId ?? ''] as const;
            if (!serverId) return 0;
            const cached = await cachedCount('artists');
            if (cached !== undefined && cached > 0) writeSnapshot(key, cached);
            const fresh = await api.controller.getAlbumArtistListCount({
                apiClientProps: { serverId, signal },
                query: {
                    sortBy: AlbumArtistListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
            });
            writeSnapshot(key, fresh);
            return fresh;
        },
        queryKey: ['library-stats', 'artists', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });
    const genres = useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<number>(['library-stats', 'genres', serverId ?? ''])) as never,
        queryFn: async ({ signal }) => {
            const key = ['library-stats', 'genres', serverId ?? ''] as const;
            if (!serverId) return 0;
            const cached = await cachedCount('genres');
            if (cached !== undefined && cached > 0) writeSnapshot(key, cached);
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
            const fresh = res?.totalRecordCount ?? 0;
            writeSnapshot(key, fresh);
            return fresh;
        },
        queryKey: ['library-stats', 'genres', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });

    return { albums, artists, genres, tracks };
};

interface TileProps {
    error?: boolean;
    label: string;
    loading?: boolean;
    to?: string;
    value: string;
}

const Tile = ({ error, label, loading, to, value }: TileProps) => {
    const inner = (
        <>
            <span className={styles.tileLabel}>{label}</span>
            <span
                className={`${styles.tileValue}${loading ? ` ${styles.loading}` : ''}${
                    error ? ` ${styles.error}` : ''
                }`}
            >
                {loading ? '' : value}
            </span>
        </>
    );
    // Errored tiles don't navigate — clicking through to an "all the things"
    // page when we couldn't even count them is just another broken UX hop.
    if (to && !error) {
        return (
            <Link className={`${styles.tile} ${styles.tileLink}`} to={to}>
                {inner}
            </Link>
        );
    }
    return <div className={styles.tile}>{inner}</div>;
};

export const LibraryStats = () => {
    const { i18n, t } = useTranslation();
    const server = useCurrentServer();
    const serverId = server?.id;
    const counts = useCounts(serverId);
    const locale = i18n.language || 'en';

    const tilesData = useMemo(
        () => [
            {
                error: counts.tracks.isError,
                label: t('page.home.libraryStats_tracks'),
                loading: counts.tracks.isLoading,
                to: AppRoute.LIBRARY_SONGS,
                value: counts.tracks.isError ? '—' : formatCount(counts.tracks.data, locale),
            },
            {
                error: counts.albums.isError,
                label: t('page.home.libraryStats_albums'),
                loading: counts.albums.isLoading,
                to: AppRoute.LIBRARY_ALBUMS,
                value: counts.albums.isError ? '—' : formatCount(counts.albums.data, locale),
            },
            {
                error: counts.artists.isError,
                label: t('page.home.libraryStats_artists'),
                loading: counts.artists.isLoading,
                to: AppRoute.LIBRARY_ALBUM_ARTISTS,
                value: counts.artists.isError ? '—' : formatCount(counts.artists.data, locale),
            },
            {
                error: counts.genres.isError,
                label: t('page.home.libraryStats_genres'),
                loading: counts.genres.isLoading,
                to: AppRoute.LIBRARY_GENRES,
                value: counts.genres.isError ? '—' : formatCount(counts.genres.data, locale),
            },
        ],
        [counts, t, locale],
    );

    return (
        <section className={styles.section}>
            <h2 className={styles.header}>{t('page.home.libraryStats_title')}</h2>
            <div className={styles.grid}>
                {tilesData.map((tile) => (
                    <Tile
                        error={tile.error}
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
