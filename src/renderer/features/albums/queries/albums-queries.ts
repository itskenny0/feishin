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
    filterAlbumsLocal,
    getActiveCacheDb,
    isCacheAvailableSync,
    markSearchDirty,
    mergePage,
    readSnapshot,
    useCachedQuery,
    writeSnapshot,
} from '/@/renderer/cache';
import {
    Album,
    AlbumDetailQuery,
    AlbumDetailResponse,
    AlbumListQuery,
    AlbumListResponse,
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

const toCachedAlbumRow = (album: Album): CachedAlbum => ({
    __cachedAt: nowMs(),
    AlbumArtistId: album.albumArtists?.[0]?.id ?? '',
    DateLastSaved: album.updatedAt ?? '',
    Id: album.id,
    Payload: album,
    ProductionYear: album.releaseYear ?? undefined,
    SortName: album.sortName ?? (album.name ?? '').toLowerCase(),
});

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
    return filterAlbumsLocal({ query, rows });
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
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db) {
                try {
                    const cached = await readAlbumsFromCache(db, query);
                    if (cached !== undefined) {
                        writeSnapshot(queryKey, cached);
                        logCacheHitSampled('list-suspense');
                    }
                } catch (err) {
                    console.warn('[cache] albums list fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getAlbumList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
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
                    console.warn('[cache] albums list apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
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
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db) {
                try {
                    const row = await db.albums.get(query.id);
                    if (row?.Payload !== undefined) {
                        writeSnapshot(queryKey, row.Payload);
                        logCacheHitSampled('detail');
                    }
                } catch (err) {
                    console.warn('[cache] album detail fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getAlbumDetail({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            })) as AlbumDetailResponse;

            if (db) {
                try {
                    await applyAlbumDetail(db, fresh);
                } catch (err) {
                    console.warn('[cache] album detail apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
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
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db) {
                try {
                    const row = await db.albums.get(query.id);
                    if (row?.Payload !== undefined) {
                        writeSnapshot(queryKey, row.Payload);
                        logCacheHitSampled('detail-suspense');
                    }
                } catch (err) {
                    console.warn('[cache] album detail fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getAlbumDetail({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            })) as AlbumDetailResponse;

            if (db) {
                try {
                    await applyAlbumDetail(db, fresh);
                } catch (err) {
                    console.warn('[cache] album detail apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
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
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db && isFullyUnfilteredCountQuery(query)) {
                try {
                    const cachedCount = await db.albums.count();
                    if (cachedCount > 0) {
                        writeSnapshot(queryKey, cachedCount);
                        logCacheHitSampled('listCount');
                    }
                } catch (err) {
                    console.warn('[cache] album listCount fromCache failed', queryKey, err);
                }
            }

            const fresh = await controller.getAlbumListCount({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            });

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
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
            if (db) {
                try {
                    const cached = await readAlbumsFromCache(db, pageQuery);
                    if (cached !== undefined && cached.items.length > 0) {
                        logCacheHitSampled('infinite');
                        // Persist the cached page back into the snapshot
                        // so the next mount's initialData includes it.
                        const existing =
                            readSnapshot<InfiniteData<AlbumListResponse, string>>(queryKey);
                        writeSnapshot(queryKey, mergePage(existing, String(startIndex), cached));
                        return cached;
                    }
                } catch (err) {
                    console.warn('[cache] album infinite fromCache failed', queryKey, err);
                }
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
