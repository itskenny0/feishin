// Cached query hooks for the albums feature.
//
// Albums are the most-browsed surface in the app, so every list / detail /
// infinite-carousel mount went straight to the network until now. These
// hooks wrap the controller calls with `useCachedQuery` /
// `useSuspenseQuery` so the IndexedDB cache primes the snapshot map before
// the network round-trip lands. Same pattern as `playlists-queries.ts` and
// `genres-queries.ts`.
//
// The albums sweep writes `CachedAlbum` rows into `db.albums` via
// `runAlbumsSweep`. These hooks read those rows back through
// `filterAlbumsLocal` (which handles sort + filter + paginate) and bulk-put
// fresh items back into the table after the remote call so subsequent
// mounts can paint from cache instantly. The detail apply also writes the
// album's nested `songs` array into `db.songs` so the album-detail page
// hydrates twice over.

import type { CachedAlbum, CachedSong } from '/@/renderer/cache/types';
import type { InfiniteData, QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { useQuery, useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query';

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    cachedSwr,
    filterAlbumsLocal,
    getActiveCacheDb,
    isCacheAvailableSync,
    markSearchDirty,
    mergePage,
    readSnapshot,
    toCachedAlbumRow as toCachedAlbumRowBase,
    useCachedQuery,
    useCacheStore,
    writeSnapshot,
} from '/@/renderer/cache';
import { queryClient } from '/@/renderer/lib/react-query';
import {
    AlbumDetailQuery,
    AlbumDetailResponse,
    AlbumListQuery,
    AlbumListResponse,
    AlbumListSort,
    ListCountQuery,
    Song,
} from '/@/shared/types/domain-types';

// ---------------------------------------------------------------------------
// Argument types
// ---------------------------------------------------------------------------

interface AlbumDetailHookOptions extends CachedQueryHookOptions {
    // Some entry points seed the detail query with a route-state hand-off
    // (e.g. the album-grid carousel pushes the visible `Album` payload into
    // navigation state and the detail page should paint from it instantly).
    // When provided this wins over the IDB snapshot.
    placeholderData?: AlbumDetailResponse | undefined;
}

interface AlbumDetailQueryArgs {
    options?: AlbumDetailHookOptions;
    query: AlbumDetailQuery;
    serverId: string | undefined;
}

interface AlbumDetailSuspenseQueryArgs extends AlbumDetailQueryArgs {
    queryKey?: QueryKey;
}

interface AlbumInfiniteListSuspenseQueryArgs {
    itemLimit: number;
    options?: CachedQueryHookOptions;
    query: Omit<AlbumListQuery, 'startIndex'>;
    queryKey?: QueryKey;
    serverId: string | undefined;
}

interface AlbumListCountQueryArgs {
    options?: CachedQueryHookOptions;
    query: ListCountQuery<AlbumListQuery>;
    serverId: string | undefined;
}

interface AlbumListQueryArgs {
    options?: CachedQueryHookOptions;
    query: AlbumListQuery;
    serverId: string | undefined;
}

interface AlbumListSuspenseQueryArgs extends AlbumListQueryArgs {
    queryKey?: QueryKey;
}

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

const nowMs = () => Date.now();

const toCachedAlbumRow = toCachedAlbumRowBase;

const toCachedSongRow = (song: Song): CachedSong => ({
    __cachedAt: nowMs(),
    AlbumArtistId: song.albumArtists?.[0]?.id,
    AlbumId: song.albumId,
    DateLastSaved: song.updatedAt ?? '',
    Id: song.id,
    IndexNumber: song.trackNumber,
    ParentIndexNumber: song.discNumber,
    Payload: song,
});

// Sample-rate the "cache hit" console log so a busy infinite scroll doesn't
// spam devtools. Counter is module-scoped so every list/detail/carousel
// mount shares the same sampling window.
let cacheHitCounter = 0;
const logCacheHitSampled = (label: string): void => {
    cacheHitCounter += 1;
    if (cacheHitCounter % 50 === 1) {
        console.info(`[cache] albums: cache hit (${label})`);
    }
};

const logApplied = (count: number): void => {
    if (count > 0) {
        console.info(`[cache] albums: applied ${count} rows`);
    }
};

// ---------------------------------------------------------------------------
// List — non-suspense
// ---------------------------------------------------------------------------

// Bug fix (cache plumbing): the previous implementation never read the
// favorites table, so `filterAlbumsLocal` always saw `favoriteAlbumIds ===
// undefined` and silently returned undefined whenever the user enabled
// the favourites filter — falling back to a network round-trip that the
// user perceives as a spinner. We now read favourites whenever the query
// opts into them, off the same `.filter()` walk used in artists-queries
// (the favorites table is small by design).
const readFavoriteAlbumIds = async (
    db: NonNullable<ReturnType<typeof getActiveCacheDb>>,
): Promise<Set<string>> => {
    // Schema v8 promoted `ItemType` to a standalone index, so this is
    // an IDB cursor scan over the (much smaller) Album-only slice
    // rather than the table-wide `.filter()` walk the prior schemas
    // forced us into.
    const rows = await db.favorites.where('ItemType').equals('Album').toArray();
    return new Set(rows.filter((r) => r.IsFavorite).map((r) => r.ItemId));
};

const readAlbumsFromCache = async (
    db: ReturnType<typeof getActiveCacheDb>,
    query: AlbumListQuery,
): Promise<AlbumListResponse | undefined> => {
    if (!db) return undefined;
    // Use the indexed `[AlbumArtistId+SortName]` compound index when the
    // query filters by exactly one artist; otherwise scan the full table.
    // `filterAlbumsLocal` is responsible for the in-memory filter + sort +
    // paginate pass and returns undefined for queries the cache can't
    // answer (compilation flag, recently-played, custom backend filters).
    let rows: CachedAlbum[];
    if (query.artistIds && query.artistIds.length === 1) {
        const artistId = query.artistIds[0];
        rows = await db.albums.where('AlbumArtistId').equals(artistId).toArray();
    } else {
        rows = await db.albums.toArray();
    }
    const needsFavorites = query.favorite !== undefined || query.sortBy === AlbumListSort.FAVORITED;
    const favoriteAlbumIds = needsFavorites ? await readFavoriteAlbumIds(db) : undefined;
    return filterAlbumsLocal({ favoriteAlbumIds, query, rows });
};

export const useAlbumListQuery = (args: AlbumListQueryArgs) => {
    const { options, query, serverId } = args;

    return useCachedQuery<AlbumListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.albums.bulkPut(items.map(toCachedAlbumRow));
            markSearchDirty('albums');
            logApplied(items.length);
        },
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db) => {
            const result = await readAlbumsFromCache(db, query);
            if (result !== undefined) logCacheHitSampled('list');
            return result;
        },
        queryKey: queryKeys.albums.list(
            serverId ?? '',
            query,
            query?.artistIds?.length === 1 ? query.artistIds[0] : undefined,
        ),
        remote: (ctx) =>
            controller.getAlbumList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<AlbumListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// List — suspense
// ---------------------------------------------------------------------------

export const useAlbumListSuspenseQuery = (args: AlbumListSuspenseQueryArgs) => {
    const { options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey =
        queryKeyOverride ??
        queryKeys.albums.list(
            serverId ?? '',
            query,
            query?.artistIds?.length === 1 ? query.artistIds[0] : undefined,
        );

    return useSuspenseQuery<AlbumListResponse>({
        initialData: () => readSnapshot<AlbumListResponse>(queryKey),
        initialDataUpdatedAt: 0,
        queryFn: (ctx) =>
            cachedSwr<AlbumListResponse>({
                apply: async (db, fresh) => {
                    const items = fresh?.items ?? [];
                    if (items.length > 0) {
                        await db.albums.bulkPut(items.map(toCachedAlbumRow));
                        markSearchDirty('albums');
                        logApplied(items.length);
                    }
                },
                ctx,
                fromCache: async (db) => {
                    const cached = await readAlbumsFromCache(db, query);
                    if (cached !== undefined) logCacheHitSampled('list-suspense');
                    return cached;
                },
                queryKey,
                remote: (ctx) =>
                    controller.getAlbumList({
                        apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                        query,
                    }) as Promise<AlbumListResponse>,
            }),
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Detail — non-suspense
// ---------------------------------------------------------------------------

const applyAlbumDetail = async (
    db: ReturnType<typeof getActiveCacheDb>,
    fresh: AlbumDetailResponse | undefined,
): Promise<void> => {
    if (!db || !fresh) return;
    await db.albums.put(toCachedAlbumRow(fresh));
    markSearchDirty('albums');
    logApplied(1);

    // The detail response usually includes the album's tracklist. Bulk-put
    // it into `db.songs` so the songs cache is primed for downstream
    // surfaces (search, song-detail navigations, queue construction).
    const songs = fresh.songs ?? [];
    if (songs.length > 0) {
        await db.songs.bulkPut(songs.map(toCachedSongRow));
        markSearchDirty('songs');
    }
};

export const useAlbumDetailQuery = (args: AlbumDetailQueryArgs) => {
    const { options, query, serverId } = args;
    const queryKey = queryKeys.albums.detail(serverId ?? '', query);
    const callerPlaceholder = options?.placeholderData;

    return useQuery<AlbumDetailResponse>({
        enabled: options?.enabled ?? Boolean(serverId),
        placeholderData: (() => {
            if (callerPlaceholder !== undefined) return callerPlaceholder;
            return readSnapshot<AlbumDetailResponse>(queryKey);
        }) as never,
        queryFn: (ctx) =>
            cachedSwr<AlbumDetailResponse>({
                apply: async (db, fresh) => {
                    await applyAlbumDetail(db, fresh);
                },
                ctx,
                fromCache: async (db) => {
                    const row = await db.albums.get(query.id);
                    const payload = row?.Payload as AlbumDetailResponse | undefined;
                    if (!payload) return undefined;
                    // Mirror the three-tier song resolution from useAlbumDetailSuspenseQuery.
                    // Without this the album sweep (which writes plain Album rows with no
                    // songs) overwrites the Dexie payload and this fromCache returns
                    // songs:[] — which propagates through the shared React Query key and
                    // erases the tracklist rendered by the suspense query in the content
                    // component, even though that query has the correct song fallbacks.
                    let songs = payload.songs ?? [];
                    if (songs.length === 0) {
                        try {
                            const songRows = await db.songs
                                .where('AlbumId')
                                .equals(query.id)
                                .toArray();
                            if (songRows.length > 0) {
                                songs = songRows
                                    .sort(
                                        (a, b) =>
                                            (a.ParentIndexNumber ?? 0) -
                                                (b.ParentIndexNumber ?? 0) ||
                                            (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0),
                                    )
                                    .map((r) => r.Payload);
                            }
                        } catch {
                            /* swallow */
                        }
                    }
                    if (songs.length === 0) {
                        const snap = readSnapshot<AlbumDetailResponse>(queryKey);
                        if (snap?.songs && snap.songs.length > 0) {
                            songs = snap.songs;
                        }
                    }
                    console.info('[cache] albums: detail cache hit', {
                        id: query.id,
                        songs: songs.length,
                    });
                    return { ...payload, songs } as AlbumDetailResponse;
                },
                queryKey,
                remote: (ctx) =>
                    controller.getAlbumDetail({
                        apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                        query,
                    }) as Promise<AlbumDetailResponse>,
            }),
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Detail — suspense
// ---------------------------------------------------------------------------

export const useAlbumDetailSuspenseQuery = (args: AlbumDetailSuspenseQueryArgs) => {
    const { options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey = queryKeyOverride ?? queryKeys.albums.detail(serverId ?? '', query);

    return useSuspenseQuery<AlbumDetailResponse>({
        initialData: () => {
            if (options?.placeholderData !== undefined) return options.placeholderData;
            return readSnapshot<AlbumDetailResponse>(queryKey);
        },
        initialDataUpdatedAt: 0,
        queryFn: (ctx) =>
            cachedSwr<AlbumDetailResponse>({
                apply: async (db, fresh) => {
                    await applyAlbumDetail(db, fresh);
                },
                ctx,
                fromCache: async (db) => {
                    const row = await db.albums.get(query.id);
                    const payload = row?.Payload as AlbumDetailResponse | undefined;
                    if (!payload) {
                        console.info('[cache] albums: detail-suspense miss (no db row)', {
                            id: query.id,
                        });
                        return undefined;
                    }
                    // Three-tier song resolution: nested in album payload →
                    // db.songs.where('AlbumId') → snapshot. The third tier
                    // protects against the "tracklist draws then erases"
                    // case the user surfaced — initialData paints songs
                    // from the snapshot, but if Dexie has 0 song rows for
                    // this album (sweep partial or AlbumId mismatch), the
                    // queryFn would otherwise return empty songs and
                    // erase the tracklist on its first render after
                    // initialData. By falling back to the snapshot here
                    // we keep the visible state.
                    let songs = payload.songs ?? [];
                    let songsSource = 'payload';
                    if (songs.length === 0) {
                        try {
                            const songRows = await db.songs
                                .where('AlbumId')
                                .equals(query.id)
                                .toArray();
                            if (songRows.length > 0) {
                                songs = songRows
                                    .sort(
                                        (a, b) =>
                                            (a.ParentIndexNumber ?? 0) -
                                                (b.ParentIndexNumber ?? 0) ||
                                            (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0),
                                    )
                                    .map((r) => r.Payload);
                                songsSource = 'db.songs';
                            }
                        } catch {
                            /* swallow */
                        }
                    }
                    if (songs.length === 0) {
                        const snap = readSnapshot<AlbumDetailResponse>(queryKey);
                        if (snap?.songs && snap.songs.length > 0) {
                            songs = snap.songs;
                            songsSource = 'snapshot';
                        } else {
                            songsSource = 'empty';
                        }
                    }
                    console.info('[cache] albums: detail-suspense cache hit', {
                        id: query.id,
                        songs: songs.length,
                        songsSource,
                    });
                    return { ...payload, songs } as AlbumDetailResponse;
                },
                queryKey,
                remote: (ctx) =>
                    controller.getAlbumDetail({
                        apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                        query,
                    }) as Promise<AlbumDetailResponse>,
            }),
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// List count — suspense
// ---------------------------------------------------------------------------

// Counts don't have a great cache story (the count IS the value, not a row),
// but for a fully unfiltered list we can serve `db.albums.count()`. For
// filtered lists we fall through to the network entirely. This wrapper
// stays minimal and just delegates to `useSuspenseQuery` with the existing
// `albumQueries.listCount` factory shape — the few `features/albums/`
// callers that go through `useItemListInfiniteLoader` / `useItemListPaginatedLoader`
// still hand the raw factory in as a `UseSuspenseQueryOptions` payload, so
// we don't disturb them.

const isFullyUnfilteredCountQuery = (query: ListCountQuery<AlbumListQuery>): boolean => {
    if (query.artistIds && query.artistIds.length > 0) return false;
    if (query.genreIds && query.genreIds.length > 0) return false;
    if (query.minYear !== undefined || query.maxYear !== undefined) return false;
    if (query.favorite !== undefined) return false;
    if (query.compilation !== undefined) return false;
    if (query.hasRating !== undefined) return false;
    if (query.isRecentlyPlayed !== undefined) return false;
    if (query.musicFolderId) return false;
    if (query.searchTerm) return false;
    if (query._custom && Object.keys(query._custom).length > 0) return false;
    return true;
};

export const useAlbumListCountQuery = (args: AlbumListCountQueryArgs) => {
    const { options, query, serverId } = args;

    const queryKey = queryKeys.albums.count(
        serverId ?? '',
        query,
        query?.artistIds?.length === 1 ? query.artistIds[0] : undefined,
    );

    return useSuspenseQuery<number>({
        initialData: () => readSnapshot<number>(queryKey),
        initialDataUpdatedAt: 0,
        queryFn: (ctx) =>
            cachedSwr<number>({
                ctx,
                fromCache: async (db) => {
                    if (query.searchTerm || (query.genreIds?.length && !query.musicFolderId)) {
                        const rows = await db.albums.toArray();
                        const result = filterAlbumsLocal({
                            query: { ...query, startIndex: 0 },
                            rows,
                        });
                        if (result !== undefined) return result.totalRecordCount ?? 0;
                    }
                    // Serve favorite-only count from Dexie so the virtual scroll
                    // doesn't collapse to 0 rows when offline (list query serves items).
                    if (
                        query.favorite !== undefined &&
                        isFullyUnfilteredCountQuery({ ...query, favorite: undefined })
                    ) {
                        const favRows = await db.favorites
                            .where('ItemType')
                            .equals('Album')
                            .toArray();
                        if (query.favorite === true) {
                            return favRows.filter((f) => f.IsFavorite).length;
                        }
                        const favCount = favRows.filter((f) => f.IsFavorite).length;
                        const total = await db.albums.count();
                        return total > 0 ? total - favCount : 0;
                    }
                    // Single-artist count is cheap via the indexed column.
                    if (
                        query.artistIds?.length === 1 &&
                        isFullyUnfilteredCountQuery({ ...query, artistIds: undefined })
                    ) {
                        const count = await db.albums
                            .where('AlbumArtistId')
                            .equals(query.artistIds[0])
                            .count();
                        if (count > 0) return count;
                    }
                    if (!isFullyUnfilteredCountQuery(query)) return undefined;
                    // Fast path: use the in-memory entity count from the Zustand store
                    // (populated by the lifecycle restore and sweep progress events).
                    // This avoids an IndexedDB read entirely and is safe to use as the
                    // count for an unfiltered list — the sweep keeps it in sync.
                    const storeCount = useCacheStore.getState().entityCounts.albums;
                    if (storeCount && storeCount > 0) {
                        logCacheHitSampled('listCount');
                        return storeCount;
                    }
                    const cachedCount = await db.albums.count();
                    if (cachedCount > 0) {
                        logCacheHitSampled('listCount');
                        return cachedCount;
                    }
                    return undefined;
                },
                queryKey,
                remote: (ctx) =>
                    controller.getAlbumListCount({
                        apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                        query,
                    }),
            }),
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Infinite list — suspense (album carousels)
// ---------------------------------------------------------------------------

// The album-detail "more from artist" / "more from genre" carousels mount
// behind a <Suspense> boundary and consume an infinite page stream. The
// page-param is a stringified offset so it matches the existing
// `queryKeys.albums.infiniteList` shape and the cached pages reuse the
// `db.albums` store via the same write-through as the list query.

export const useAlbumInfiniteListSuspenseQuery = (args: AlbumInfiniteListSuspenseQueryArgs) => {
    const { itemLimit, options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey =
        queryKeyOverride ??
        queryKeys.albums.infiniteList(
            serverId ?? '',
            // The infinite query carries a base query without a startIndex;
            // include a startIndex=0 sentinel so the queryKey factory's
            // `splitPaginatedQuery` helper sees a consistent shape.
            { ...query, startIndex: 0 },
            query?.artistIds?.length === 1 ? query.artistIds[0] : undefined,
        );

    return useSuspenseInfiniteQuery<
        AlbumListResponse,
        Error,
        InfiniteData<AlbumListResponse, string>,
        QueryKey,
        string
    >({
        getNextPageParam: (lastPage, _allPages, lastPageParam) => {
            if (lastPage.items.length < itemLimit) return undefined;
            const next = Number(lastPageParam) + itemLimit;
            return String(next);
        },
        // Seed the suspense query with the IDB snapshot when one exists so
        // the carousel can paint instantly on warm mounts (e.g. Home,
        // album-detail "More from this Artist") instead of suspending on
        // the network round-trip. `initialDataUpdatedAt: 0` keeps the
        // result marked stale so React Query still revalidates in the
        // background — we just don't block paint waiting for the answer.
        initialData: (() =>
            readSnapshot<InfiniteData<AlbumListResponse, string>>(queryKey)) as never,
        initialDataUpdatedAt: 0,
        initialPageParam: '0',
        queryFn: async (ctx: QueryFunctionContext<QueryKey, string>) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
            const startIndex = Number(ctx.pageParam);
            const pageQuery: AlbumListQuery = {
                ...query,
                limit: itemLimit,
                startIndex,
            };

            // Read-through: if the local cache has every row this page
            // would need, return the cached page directly and let the
            // background revalidation update the snapshot. This is what
            // turns "warm" into a real <50ms paint instead of a full
            // server round-trip.
            let cached: AlbumListResponse | undefined;
            if (db) {
                try {
                    const fromCache = await readAlbumsFromCache(db, pageQuery);
                    if (fromCache !== undefined && fromCache.items.length > 0) {
                        cached = fromCache;
                        logCacheHitSampled('infinite');
                        // Persist the cached page back into the snapshot
                        // so the next mount's initialData includes it.
                        const existing =
                            readSnapshot<InfiniteData<AlbumListResponse, string>>(queryKey);
                        writeSnapshot(queryKey, mergePage(existing, String(startIndex), cached));
                    }
                } catch (err) {
                    console.warn('[cache] album infinite fromCache failed', queryKey, err);
                }
            }

            if (cached !== undefined) {
                // Background revalidate so an offline session never throws
                // out of queryFn when the cache has the page.
                void (async () => {
                    try {
                        const fresh = (await controller.getAlbumList({
                            apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                            query: pageQuery,
                        })) as AlbumListResponse;
                        if (db) {
                            try {
                                const items = fresh?.items ?? [];
                                if (items.length > 0) {
                                    await db.albums.bulkPut(items.map(toCachedAlbumRow));
                                    markSearchDirty('albums');
                                    logApplied(items.length);
                                }
                            } catch (err) {
                                console.warn(
                                    '[cache] album infinite apply failed (bg)',
                                    queryKey,
                                    err,
                                );
                            }
                        }
                        const existing =
                            readSnapshot<InfiniteData<AlbumListResponse, string>>(queryKey);
                        const next = mergePage(existing, String(startIndex), fresh);
                        writeSnapshot(queryKey, next);
                        queryClient.setQueryData(queryKey, next);
                    } catch (err) {
                        if ((err as Error)?.name !== 'AbortError') {
                            console.info(
                                '[cache] album infinite bg revalidate failed',
                                queryKey,
                                err,
                            );
                        }
                    }
                })();
                return cached;
            }

            const fresh = (await controller.getAlbumList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: pageQuery,
            })) as AlbumListResponse;

            if (db) {
                try {
                    const items = fresh?.items ?? [];
                    if (items.length > 0) {
                        await db.albums.bulkPut(items.map(toCachedAlbumRow));
                        markSearchDirty('albums');
                        logApplied(items.length);
                    }
                } catch (err) {
                    console.warn('[cache] album infinite apply failed', queryKey, err);
                }
            }

            const existing = readSnapshot<InfiniteData<AlbumListResponse, string>>(queryKey);
            writeSnapshot(queryKey, mergePage(existing, String(startIndex), fresh));
            return fresh;
        },
        queryKey,
        staleTime: options?.staleTime,
    });
};
