import type { CachedFavorite } from '../types';
import type { SweepContext } from './sweep';

import { useCacheStore } from '../store';

import { controller } from '/@/renderer/api/controller';
import {
    AlbumArtistListSort,
    AlbumListSort,
    ServerListItem,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

// Favorites sweep does NOT use runSweep because Jellyfin has no single
// "all favorites" endpoint.  Instead we call the three per-entity list
// endpoints filtered by favorite and write CachedFavorite rows directly.

const FAVORITES_PAGE_SIZE = 500;

// Mutable accumulator shared across the three sub-fetches so we can emit a
// single coherent SweepProgress to the cache store between pages.
interface FavoritesProgressAcc {
    bytesDownloaded: number;
    done: number;
    sweepStartedAt: number;
}

const emitFavoritesProgress = (acc: FavoritesProgressAcc): void => {
    const actions = useCacheStore.getState().actions;
    const elapsed = (Date.now() - acc.sweepStartedAt) / 1000;
    const itemsPerSec = elapsed > 0 ? acc.done / elapsed : 0;
    const bytesPerSec = acc.bytesDownloaded / Math.max(1, elapsed);
    actions.setSweep({
        entity: 'favorites',
        progress: {
            bytesDownloaded: acc.bytesDownloaded,
            bytesPerSec,
            done: acc.done,
            // Favorites has no upfront total across the three sub-fetches,
            // so we don't extrapolate a total payload size.
            estimatedTotalBytes: undefined,
            itemsPerSec,
            startedAt: acc.sweepStartedAt,
            total: undefined,
        },
    });
};

const collectFavorites = async <T>(
    label: 'albums' | 'artists' | 'songs',
    signal: AbortSignal,
    fetchPage: (startIndex: number, limit: number) => Promise<{ items: T[]; total: number }>,
    toFavorite: (item: T, cachedAt: number) => CachedFavorite,
    acc: FavoritesProgressAcc,
): Promise<CachedFavorite[]> => {
    console.info(`[cache] sweep:favorites ${label} begin`);
    const collected: CachedFavorite[] = [];
    let startIndex = 0;
    while (!signal.aborted) {
        const { items, total } = await fetchPage(startIndex, FAVORITES_PAGE_SIZE);
        const now = Date.now();
        const pageBytes = items.reduce((a, it) => a + JSON.stringify(it).length, 0);
        acc.bytesDownloaded += pageBytes;
        acc.done += items.length;
        for (const item of items) collected.push(toFavorite(item, now));
        startIndex += items.length;
        emitFavoritesProgress(acc);
        if (items.length < FAVORITES_PAGE_SIZE || startIndex >= (total ?? 0)) break;
    }
    console.info(`[cache] sweep:favorites ${label} done`, { count: collected.length });
    return collected;
};

export const runFavoritesSweep = async (
    ctx: SweepContext,
    server: ServerListItem,
): Promise<void> => {
    const { db, signal } = ctx;
    const actions = useCacheStore.getState().actions;
    const now = Date.now();

    // Read any previously-persisted progress so we can skip completed phases
    // when resuming after an abort.
    const existingMeta = await db.syncMeta.get('favorites');
    const startPhase = existingMeta?.nextStartIndex ?? 0;

    await db.syncMeta.put({
        EntityType: 'favorites',
        hydrationState: 'partial',
        lastFullSyncAt: existingMeta?.lastFullSyncAt,
        lastSweepAt: now,
        nextStartIndex: startPhase > 0 ? startPhase : undefined,
        pausedUntil: undefined,
        totalCount: undefined,
    });
    actions.setHydrationState('favorites', 'partial');
    console.info('[cache] sweep:favorites start', {
        resumingFromPhase: startPhase,
        serverId: server.id,
    });

    const acc: FavoritesProgressAcc = {
        bytesDownloaded: 0,
        done: 0,
        sweepStartedAt: now,
    };
    // Emit an initial zeroed progress so the chip/dashboard show "Syncing
    // favourites" the moment the sweep starts, before any page lands.
    emitFavoritesProgress(acc);

    // Helper to persist a mid-sweep checkpoint.  `nextStartIndex` is
    // repurposed here to track which phase has completed: 1 = albums done,
    // 2 = artists done, 3 = songs done.
    const checkpoint = async (phaseCompleted: number): Promise<void> => {
        await db.syncMeta.put({
            EntityType: 'favorites',
            hydrationState: 'partial',
            lastFullSyncAt: existingMeta?.lastFullSyncAt,
            lastSweepAt: Date.now(),
            nextStartIndex: phaseCompleted,
            pausedUntil: undefined,
            totalCount: undefined,
        });
        console.info('[cache] sweep:favorites checkpoint', { phase: phaseCompleted });
    };

    let albums: CachedFavorite[] = [];
    if (startPhase < 1) {
        albums = await collectFavorites(
            'albums',
            signal,
            async (startIndex, limit) => {
                const result = await controller.getAlbumList({
                    apiClientProps: { serverId: server.id, signal },
                    query: {
                        favorite: true,
                        limit,
                        sortBy: AlbumListSort.NAME,
                        sortOrder: SortOrder.ASC,
                        startIndex,
                    },
                });
                return {
                    items: result?.items ?? [],
                    total: result?.totalRecordCount ?? 0,
                };
            },
            (album, cachedAt) => ({
                __cachedAt: cachedAt,
                IsFavorite: true,
                ItemId: album.id,
                ItemType: 'Album',
                LastPlayedDate: album.lastPlayedAt ?? undefined,
                PlayCount: album.playCount ?? 0,
                Rating: album.userRating ?? undefined,
            }),
            acc,
        );
        if (signal.aborted) {
            console.info('[cache] sweep:favorites aborted');
            return;
        }
        await db.favorites.bulkPut(albums);
        emitFavoritesProgress(acc);
        await checkpoint(1);
    }

    if (signal.aborted) return;

    let artists: CachedFavorite[] = [];
    if (startPhase < 2) {
        artists = await collectFavorites(
            'artists',
            signal,
            async (startIndex, limit) => {
                const result = await controller.getAlbumArtistList({
                    apiClientProps: { serverId: server.id, signal },
                    query: {
                        favorite: true,
                        limit,
                        sortBy: AlbumArtistListSort.NAME,
                        sortOrder: SortOrder.ASC,
                        startIndex,
                    },
                });
                return {
                    items: result?.items ?? [],
                    total: result?.totalRecordCount ?? 0,
                };
            },
            (artist, cachedAt) => ({
                __cachedAt: cachedAt,
                IsFavorite: true,
                ItemId: artist.id,
                ItemType: 'AlbumArtist',
                LastPlayedDate: artist.lastPlayedAt ?? undefined,
                PlayCount: artist.playCount ?? 0,
                Rating: artist.userRating ?? undefined,
            }),
            acc,
        );
        if (signal.aborted) {
            console.info('[cache] sweep:favorites aborted');
            return;
        }
        await db.favorites.bulkPut(artists);
        emitFavoritesProgress(acc);
        await checkpoint(2);
    }

    if (signal.aborted) return;

    let songs: CachedFavorite[] = [];
    if (startPhase < 3) {
        songs = await collectFavorites(
            'songs',
            signal,
            async (startIndex, limit) => {
                const result = await controller.getSongList({
                    apiClientProps: { serverId: server.id, signal },
                    query: {
                        favorite: true,
                        limit,
                        sortBy: SongListSort.NAME,
                        sortOrder: SortOrder.ASC,
                        startIndex,
                    },
                });
                return {
                    items: result?.items ?? [],
                    total: result?.totalRecordCount ?? 0,
                };
            },
            (song, cachedAt) => ({
                __cachedAt: cachedAt,
                IsFavorite: true,
                ItemId: song.id,
                ItemType: 'Song',
                LastPlayedDate: song.lastPlayedAt ?? undefined,
                PlayCount: song.playCount,
                Rating: song.userRating ?? undefined,
            }),
            acc,
        );
        if (signal.aborted) {
            console.info('[cache] sweep:favorites aborted');
            return;
        }
        await db.favorites.bulkPut(songs);
        emitFavoritesProgress(acc);
        await checkpoint(3);
    }

    const totalRows = albums.length + artists.length + songs.length;
    console.info('[cache] sweep:favorites all sub-fetches done', {
        albums: albums.length,
        artists: artists.length,
        songs: songs.length,
    });

    const completedAt = Date.now();
    await db.syncMeta.put({
        EntityType: 'favorites',
        hydrationState: 'full',
        lastFullSyncAt: completedAt,
        lastSweepAt: completedAt,
        nextStartIndex: undefined,
        pausedUntil: undefined,
        totalCount: totalRows,
    });

    actions.setEntityCount('favorites', totalRows);
    actions.setHydrationState('favorites', 'full');
    actions.setSweep(undefined);
    console.info('[cache] sweep:favorites done', {
        durationMs: Date.now() - now,
        totalRows,
    });
};
