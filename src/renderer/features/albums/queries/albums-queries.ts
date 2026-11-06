// Cached query hooks for the albums feature.
//
// These wrap the controller calls with `useQuery` / `useSuspenseQuery` /
// `useSuspenseInfiniteQuery` + `cachedSwr` so the IndexedDB cache primes the
// snapshot map before the network round-trip lands. Same pattern as
// `playlists-queries.ts` and `genres-queries.ts`.
//
// The albums sweep writes `CachedAlbum` rows into `db.albums`. These hooks
// read them back (detail by id, counts via `filterAlbumsLocal`, carousel
// pages via `resolveAlbumPage`) and bulk-put fresh items back into the table
// after the remote call so subsequent mounts can paint from cache instantly.
// The detail apply also writes the album's nested `songs` array into
// `db.songs` so the album-detail page hydrates twice over.

import type { CachedSong } from '/@/renderer/cache/types';
import type { InfiniteData, QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { useQuery, useSuspenseInfiniteQuery, useSuspenseQuery } from '@tanstack/react-query';

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    cachedSwr,
    cacheFavoriteCount,
    filterAlbumsLocal,
    getActiveCacheDb,
    isCacheAvailableSync,
    LibraryCacheDb,
    markRowsChangedFromPage,
    markSearchDirty,
    mergePage,
    pageRefsFromItems,
    readEntityCountFallback,
    readSnapshot,
    resolveAlbumPage,
    shouldRevalidateFromNetwork,
    toCachedAlbumRow,
    toCachedSongRow,
    useCacheStore,
    writeSnapshot,
} from '/@/renderer/cache';
import { queryClient } from '/@/renderer/lib/react-query';
import {
    Album,
    AlbumDetailQuery,
    AlbumDetailResponse,
    AlbumListQuery,
    AlbumListResponse,
    ListCountQuery,
} from '/@/shared/types/domain-types';

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

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

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

const writeAlbumRows = async (db: LibraryCacheDb, items: Album[]): Promise<void> => {
    if (items.length === 0) return;
    await db.albums.bulkPut(items.map(toCachedAlbumRow));
    markSearchDirty('albums');
    // Change-aware: a background revalidate that re-applies the same rows
    // keeps the grid row cache; only a genuine change drops it.
    markRowsChangedFromPage('albums', pageRefsFromItems(items));
    console.info(`[cache] albums: applied ${items.length} rows`);
};

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

const applyAlbumDetail = async (
    db: LibraryCacheDb,
    fresh: AlbumDetailResponse | undefined,
): Promise<void> => {
    if (!fresh) return;
    await writeAlbumRows(db, [fresh]);

    // The detail response usually includes the album's tracklist. Bulk-put
    // it into `db.songs` so the songs cache is primed for downstream
    // surfaces (search, song-detail navigations, queue construction).
    const songs = fresh.songs ?? [];
    if (songs.length > 0) {
        await db.songs.bulkPut(songs.map(toCachedSongRow));
        markSearchDirty('songs');
        markRowsChangedFromPage('songs', pageRefsFromItems(songs));
    }
};

const byDiscThenTrack = (a: CachedSong, b: CachedSong): number =>
    (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) ||
    (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0);

// Shared by the suspense and non-suspense detail hooks: they use the same
// React Query key, so they must agree on what a cache hit is. Three-tier
// song resolution: nested in album payload -> db.songs.where('AlbumId') ->
// snapshot. The album sweep writes plain Album rows with no songs; without
// the fallbacks a cache hit would return songs:[] and erase a tracklist the
// snapshot already painted.
const readAlbumDetailFromCache = async (
    db: LibraryCacheDb,
    id: string,
    queryKey: QueryKey,
): Promise<AlbumDetailResponse | undefined> => {
    const payload = (await db.albums.get(id))?.Payload as AlbumDetailResponse | undefined;
    if (!payload) {
        console.info('[cache] albums: detail miss (no db row)', { id });
        return undefined;
    }
    let songs = payload.songs ?? [];
    let songsSource = 'payload';
    if (songs.length === 0) {
        const songRows = await db.songs
            .where('AlbumId')
            .equals(id)
            .toArray()
            .catch(() => []);
        songs = songRows.sort(byDiscThenTrack).map((r) => r.Payload);
        songsSource = 'db.songs';
    }
    if (songs.length === 0) {
        songs = readSnapshot<AlbumDetailResponse>(queryKey)?.songs ?? [];
        songsSource = songs.length > 0 ? 'snapshot' : 'empty';
    }
    // Don't serve a PARTIAL tracklist as an authoritative hit. When the
    // sweep has cached only some of the album's tracks, `db.songs` returns
    // fewer rows than the album's real `songCount` (e.g. 4 of 131). Serving
    // that pins the truncated list forever because sync-first suppresses
    // the background revalidate, so treat it as a miss and fetch the album.
    const expectedSongs = payload.songCount ?? 0;
    if (expectedSongs > 0 && songs.length < expectedSongs) {
        console.info('[cache] albums: detail incomplete tracklist - fetching full', {
            have: songs.length,
            id,
            source: songsSource,
            want: expectedSongs,
        });
        return undefined;
    }
    console.info('[cache] albums: detail cache hit', { id, songs: songs.length, songsSource });
    return { ...payload, songs };
};

const albumDetailQueryFn =
    (query: AlbumDetailQuery, queryKey: QueryKey, serverId: string | undefined) =>
    (ctx: QueryFunctionContext) =>
        cachedSwr<AlbumDetailResponse>({
            apply: applyAlbumDetail,
            ctx,
            fromCache: (db) => readAlbumDetailFromCache(db, query.id, queryKey),
            queryKey,
            remote: ({ signal }) =>
                controller.getAlbumDetail({
                    apiClientProps: { serverId: serverId ?? '', signal },
                    query,
                }) as Promise<AlbumDetailResponse>,
        });

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
        queryFn: albumDetailQueryFn(query, queryKey, serverId),
        queryKey,
        staleTime: options?.staleTime,
    });
};

export const useAlbumDetailSuspenseQuery = (args: AlbumDetailSuspenseQueryArgs) => {
    const { options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey = queryKeyOverride ?? queryKeys.albums.detail(serverId ?? '', query);

    return useSuspenseQuery<AlbumDetailResponse>({
        initialData: () => {
            if (options?.placeholderData !== undefined) return options.placeholderData;
            return readSnapshot<AlbumDetailResponse>(queryKey);
        },
        initialDataUpdatedAt: 0,
        queryFn: albumDetailQueryFn(query, queryKey, serverId),
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
        // Seed the count synchronously so the grid doesn't suspend on a cold
        // COUNT (which waits up to 3s on waitForActiveDb() + db.count()).
        // For a fully-unfiltered list the in-memory store count is an exact,
        // sweep-maintained answer, so prefer snapshot → store. For filtered
        // lists the store count would be wrong, so only the snapshot seeds
        // and the queryFn computes the real filtered count. initialDataUpdatedAt:0
        // keeps the value stale so the background refresh still runs.
        initialData: () =>
            isFullyUnfilteredCountQuery(query)
                ? readEntityCountFallback(queryKey, 'albums')
                : readSnapshot<number>(queryKey),
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
                        const favoriteCount = favRows.filter((f) => f.IsFavorite).length;
                        return cacheFavoriteCount({
                            favorite: query.favorite,
                            favoriteCount,
                            totalCount: query.favorite ? 0 : await db.albums.count(),
                        });
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

            // Network page: write the rows through to Dexie and merge the page
            // into the snapshot so the next mount's initialData includes it.
            const fetchPage = async () => {
                const fresh = (await controller.getAlbumList({
                    apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                    query: pageQuery,
                })) as AlbumListResponse;
                if (db) {
                    await writeAlbumRows(db, fresh?.items ?? []).catch((err) =>
                        console.warn('[cache] album infinite apply failed', queryKey, err),
                    );
                }
                const next = mergePage(
                    readSnapshot<InfiniteData<AlbumListResponse, string>>(queryKey),
                    String(startIndex),
                    fresh,
                );
                writeSnapshot(queryKey, next);
                return { fresh, next };
            };

            // Read-through: if the local cache has every row this page
            // would need, return the cached page directly and let the
            // background revalidation update the snapshot. This is what
            // turns "warm" into a real <50ms paint instead of a full
            // server round-trip.
            //
            // Pages MUST come from resolveAlbumPage (sorted-result memo),
            // not a fresh filter pass per page: RANDOM sort re-shuffles on
            // every call, so per-page filtering handed each page a slice of
            // a DIFFERENT permutation — duplicate and skipped albums across
            // page boundaries in the "more from artist/genre" carousels.
            let cached: AlbumListResponse | undefined;
            if (db) {
                try {
                    const fromCache = await resolveAlbumPage({
                        limit: itemLimit,
                        query: pageQuery,
                        startIndex,
                    });
                    if (fromCache !== undefined && fromCache.items.length > 0) {
                        cached = {
                            items: fromCache.items as AlbumListResponse['items'],
                            startIndex,
                            totalRecordCount: fromCache.totalRecordCount,
                        };
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
                // out of queryFn when the cache has the page. Gated through
                // the shared sync-first predicate: when the local cache is
                // authoritative the sweep owns freshness and no automatic
                // network call fires after a cache hit (an explicit refresh
                // re-opens the window).
                if (shouldRevalidateFromNetwork()) {
                    void fetchPage()
                        .then(({ next }) => queryClient.setQueryData(queryKey, next))
                        .catch((err) => {
                            if ((err as Error)?.name !== 'AbortError') {
                                console.info(
                                    '[cache] album infinite bg revalidate failed',
                                    queryKey,
                                    err,
                                );
                            }
                        });
                }
                return cached;
            }

            return (await fetchPage()).fresh;
        },
        queryKey,
        staleTime: options?.staleTime,
    });
};
