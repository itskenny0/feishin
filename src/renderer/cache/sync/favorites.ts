import type { CachedFavorite } from '../types';
import type { SweepContext } from './sweep';

import { markRowsChanged } from '../local-cache';
import { useCacheStore } from '../store';
import { isSweepNetworkError } from './sweep';

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

// Module-level UTF-8 encoder for byte-length accounting. `.length` on a
// JS string returns UTF-16 code units, not real wire bytes; TextEncoder
// gives the actual UTF-8 size without per-item Blob allocation.
const _utf8Encoder = new TextEncoder();
const utf8ByteLength = (s: string): number => _utf8Encoder.encode(s).length;

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
        const pageBytes = items.reduce((a, it) => a + utf8ByteLength(JSON.stringify(it)), 0);
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

// THE single source of truth for a favourites reconciliation key. Both the
// "fresh" set and the membership check MUST go through this so their separators
// can never diverge. A prior version built the fresh set with a NUL separator
// and checked membership with a space — so no key ever matched and the
// reconciliation pass deleted EVERY favourite the sweep had just written,
// leaving the favourites table empty and every favourite-filtered view stuck at
// zero.
export const favoriteKey = (itemId: string, itemType: string): string => `${itemId} ${itemType}`;

/**
 * Pure reconciliation helper: given every favourites row, the set of
 * `favoriteKey(...)` values observed in THIS sweep, and the set of ItemTypes
 * whose sub-fetch actually returned data this run, return the keys that should
 * be pruned.
 *
 * Two guards prevent the favourite-wipe bug:
 *  - Only `IsFavorite` rows are candidates (never touch IsFavorite:false rows,
 *    which carry rating / play-count baselines).
 *  - Only prune a row whose `ItemType` was authoritatively observed this run
 *    (its sub-fetch returned ≥1 item). A sub-fetch that came back empty — a
 *    transient server hiccup or an aborted page — contributes no fresh keys,
 *    so without this guard every favourite of that type would be deleted.
 */
export const computeStaleFavoriteKeys = (
    rows: Array<{ IsFavorite?: boolean; ItemId: string; ItemType: string }>,
    freshKeys: Set<string>,
    fetchedTypes: Set<string>,
): Array<[string, string]> => {
    const stale: Array<[string, string]> = [];
    for (const row of rows) {
        if (!row.IsFavorite) continue;
        if (!fetchedTypes.has(row.ItemType)) continue;
        if (freshKeys.has(favoriteKey(row.ItemId, row.ItemType))) continue;
        stale.push([row.ItemId, row.ItemType]);
    }
    return stale;
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

    // Reconciliation: when this run owns the full sweep (no resume from a
    // mid-sweep checkpoint), accumulate every fresh `[ItemId+ItemType]`
    // key the server reports so we can drop stale rows at the end. We
    // intentionally skip this when resuming because earlier phases'
    // rows were written in a previous run and aren't observed here -
    // reconciling against an incomplete fresh set would nuke real
    // favourites that happen to live in a phase we skipped.
    const reconcile = startPhase === 0;
    const freshKeys: Set<string> = new Set();
    // ItemTypes whose sub-fetch returned data this run. Only these are pruned
    // during reconciliation: an empty sub-fetch (transient server error /
    // aborted page) is not authoritative and must not wipe that type's
    // favourites. See `computeStaleFavoriteKeys`.
    const fetchedTypes: Set<string> = new Set();
    const trackFresh = (rows: CachedFavorite[]): void => {
        if (!reconcile) return;
        for (const row of rows) {
            freshKeys.add(favoriteKey(row.ItemId, row.ItemType));
            fetchedTypes.add(row.ItemType);
        }
    };

    let albums: CachedFavorite[] = [];
    try {
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
            trackFresh(albums);
            // The albums table is swept BEFORE favourites, so any
            // favourite-filtered album list (e.g. the sidebar "Favourite
            // albums" section) may have already computed and memoised an
            // EMPTY sorted list against an empty favourites set. Drop the
            // albums row/sorted cache so the next read recomputes against the
            // freshly-written favourites instead of serving the stale empty
            // memo. Without this the sidebar stayed empty until a server
            // switch. (The album-api fromCache guard handles the cold path;
            // this covers a memo that landed before these rows were written.)
            markRowsChanged('albums');
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
            trackFresh(artists);
            // Same rationale as the albums phase: drop any favourite-filtered
            // artist memo computed before these favourite rows landed.
            markRowsChanged('artists');
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
            trackFresh(songs);
            // Same rationale as the albums phase: drop any favourite-filtered
            // song memo computed before these favourite rows landed.
            markRowsChanged('songs');
            emitFavoritesProgress(acc);
            await checkpoint(3);
        }

        const totalRows = albums.length + artists.length + songs.length;
        console.info('[cache] sweep:favorites all sub-fetches done', {
            albums: albums.length,
            artists: artists.length,
            songs: songs.length,
        });

        // Reconciliation: prune rows whose server-side favourite state has
        // flipped to false since the last sweep. Only safe when (a) this
        // run owned the full sweep from phase 0 so `freshKeys` is the
        // complete server-side truth, and (b) the abort signal hasn't
        // fired between the last phase write and now. A mid-cancel here
        // would otherwise delete favourites the server still considers
        // favourite - we just couldn't observe them this run.
        if (reconcile && !signal.aborted) {
            // Only FAVOURITE rows are reconciliation candidates. The favorites
            // table also stores IsFavorite:false rows that carry a Rating /
            // PlayCount / LastPlayedDate (written by setRating and
            // incrementPlayCount). Those are never in the server's
            // favourite-filtered fresh set, so pruning by "key not in freshKeys"
            // would delete a user's ratings and play-count baselines on every
            // full sweep. Read the rows (tiny — no blobs) and prune only rows
            // the server no longer marks favourite.
            const allRows = await db.favorites.toArray();
            const stale = computeStaleFavoriteKeys(allRows, freshKeys, fetchedTypes);
            if (stale.length > 0) {
                await db.favorites.bulkDelete(stale);
                // Pruning favourite rows can change every favourite-filtered
                // list result; drop the row/sorted memos so the next read
                // recomputes against the reconciled favourites set.
                markRowsChanged('albums');
                markRowsChanged('artists');
                markRowsChanged('songs');
                console.info('[cache] sweep:favorites reconciled stale rows', {
                    fresh: freshKeys.size,
                    removed: stale.length,
                });
            } else {
                console.info('[cache] sweep:favorites reconciled - no stale rows', {
                    fresh: freshKeys.size,
                });
            }
        }

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
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        if (isSweepNetworkError(err)) {
            console.warn(
                '[cache] sweep:favorites network error - checkpoint preserved for resume',
                {
                    error: (err as Error)?.message,
                },
            );
            actions.setSweep(undefined);
            return;
        }
        throw err;
    }
};
