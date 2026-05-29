import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { getOptimizedListCount } from '/@/renderer/api/utils-list-count';
import {
    buildListSignature,
    cachedSwr,
    filterAlbumsLocal,
    getOrComputeSorted,
    loadAlbumsRows,
    readSnapshot,
    toCachedAlbumRow,
    toCachedSongRow,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    AlbumDetailQuery,
    AlbumDetailResponse,
    AlbumListQuery,
    AlbumListResponse,
    AlbumListSort,
    ListCountQuery,
} from '/@/shared/types/domain-types';

// NOTE: for component-level hook usage prefer the cache-aware wrappers in
// `/@/renderer/features/albums/queries/albums-queries.ts`. The factories
// below remain for cross-feature consumers (the player queue, the home
// page, the sidebar favorites, route preloaders) that compose
// queryOptions directly via `queryClient.fetchQuery` / `prefetchQuery` or
// hand the options object to a generic list-loader. Keeping both paths
// available means we don't have to migrate every external consumer at the
// same time the in-feature components move onto cached hooks.
export const albumQueries = {
    detail: (args: QueryHookArgs<AlbumDetailQuery>) => {
        const key = queryKeys.albums.detail(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<AlbumDetailResponse>({
                    apply: async (db, fresh) => {
                        if (!fresh) return;
                        await db.albums.put(toCachedAlbumRow(fresh));
                        const songs = fresh.songs ?? [];
                        if (songs.length > 0) {
                            await db.songs.bulkPut(songs.map(toCachedSongRow));
                        }
                    },
                    ctx,
                    fromCache: async (db) => {
                        if (!args.query?.id) return undefined;
                        const row = await db.albums.get(args.query.id);
                        const payload = row?.Payload as AlbumDetailResponse | undefined;
                        if (!payload) return undefined;
                        // If the row came from the list endpoint it lacks a
                        // nested `songs` array. Previously we returned
                        // undefined here so the queryFn fell through to the
                        // network — but on a cold-offline session that
                        // produced a `null` from `cachedSwr` and the UI
                        // erased its already-rendered tracklist a split-
                        // second after first paint. Assemble the tracklist
                        // from `db.songs.where('AlbumId')` instead, so the
                        // cached path always returns something usable.
                        let songs = payload.songs ?? [];
                        if (songs.length === 0) {
                            try {
                                const rows = await db.songs
                                    .where('AlbumId')
                                    .equals(args.query.id)
                                    .toArray();
                                rows.sort((a, b) => {
                                    const aDisc = a.ParentIndexNumber ?? 1;
                                    const bDisc = b.ParentIndexNumber ?? 1;
                                    if (aDisc !== bDisc) return aDisc - bDisc;
                                    return (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0);
                                });
                                songs = rows.map((r) => r.Payload);
                            } catch {
                                /* fall through with empty songs */
                            }
                        }
                        console.info('[cache] albums: detail cache hit', {
                            id: args.query.id,
                            songs: songs.length,
                            songsSource: payload.songs?.length
                                ? 'detail-payload'
                                : songs.length > 0
                                  ? 'db.songs'
                                  : 'empty',
                        });
                        return { ...payload, songs } as AlbumDetailResponse;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumDetail({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<AlbumDetailResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    list: (args: QueryHookArgs<AlbumListQuery>) => {
        const key = queryKeys.albums.list(
            args.serverId,
            args.query,
            args.query?.artistIds?.length === 1 ? args.query?.artistIds[0] : undefined,
        );
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<AlbumListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.albums.bulkPut(items.map(toCachedAlbumRow));
                        }
                    },
                    ctx,
                    fromCache: async (db) => {
                        // Read the filtered album subset from Dexie so the
                        // artist-detail "albums by this artist" surface, the
                        // sidebar favourites, and every other list consumer
                        // serves from local storage instead of awaiting the
                        // network. Picks the cheapest available Dexie index,
                        // then asks the renderer-side memo for a previously
                        // computed sorted result before doing the work.
                        const singleArtist =
                            args.query?.artistIds && args.query.artistIds.length === 1
                                ? args.query.artistIds[0]
                                : undefined;

                        // Signature includes "scope" so a single-artist
                        // list doesn't collide with the full-library list.
                        const sig = buildListSignature(
                            `albums:list:${singleArtist ?? 'all'}`,
                            (args.query ?? {}) as unknown as Record<string, unknown>,
                        );

                        const sorted = await getOrComputeSorted<unknown>(
                            'albums',
                            sig,
                            async () => {
                                const rows = singleArtist
                                    ? await db.albums
                                          .where('AlbumArtistId')
                                          .equals(singleArtist)
                                          .toArray()
                                    : await loadAlbumsRows(db);
                                if (rows.length === 0) return undefined;
                                let favoriteAlbumIds: Set<string> | undefined;
                                const needsFavorites =
                                    args.query?.favorite !== undefined ||
                                    args.query?.sortBy === AlbumListSort.FAVORITED;
                                if (needsFavorites) {
                                    const favs = await db.favorites
                                        .where('ItemType')
                                        .equals('Album')
                                        .toArray();
                                    favoriteAlbumIds = new Set(
                                        favs.filter((f) => f.IsFavorite).map((f) => f.ItemId),
                                    );
                                }
                                const result = filterAlbumsLocal({
                                    favoriteAlbumIds,
                                    query: { ...args.query, limit: undefined, startIndex: 0 },
                                    rows,
                                });
                                return result?.items;
                            },
                        );
                        if (sorted === undefined) return undefined;
                        const startIndex = args.query?.startIndex ?? 0;
                        const limit = args.query?.limit;
                        const items =
                            limit === undefined
                                ? sorted.slice(startIndex)
                                : sorted.slice(startIndex, startIndex + limit);
                        return {
                            items,
                            startIndex,
                            totalRecordCount: sorted.length,
                        } as AlbumListResponse;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<AlbumListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    listCount: (args: QueryHookArgs<ListCountQuery<AlbumListQuery>>) => {
        const key = queryKeys.albums.count(
            args.serverId,
            args.query,
            args.query?.artistIds?.length === 1 ? args.query?.artistIds[0] : undefined,
        );
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
                        if (args.query.searchTerm || args.query.genreIds?.length) {
                            const rows = await db.albums.toArray();
                            const result = filterAlbumsLocal({
                                query: { ...args.query, startIndex: 0 },
                                rows,
                            });
                            if (result !== undefined) return result.totalRecordCount ?? 0;
                        }
                        // Serve favorite-only count from Dexie so the favorites albums
                        // list shows items offline (list query already has the rows;
                        // without a count the virtual scroll renders 0 rows).
                        if (args.query.favorite !== undefined && !args.query.artistIds) {
                            const favRows = await db.favorites
                                .where('ItemType')
                                .equals('Album')
                                .toArray();
                            if (args.query.favorite === true) {
                                return favRows.filter((f) => f.IsFavorite).length;
                            }
                            const favCount = favRows.filter((f) => f.IsFavorite).length;
                            const total = await db.albums.count();
                            return total > 0 ? total - favCount : 0;
                        }
                        // Single-artist album count is cheap via Dexie index.
                        if (args.query.artistIds?.length === 1) {
                            const count = await db.albums
                                .where('AlbumArtistId')
                                .equals(args.query.artistIds[0])
                                .count();
                            return count > 0 ? count : undefined;
                        }
                        if (args.query.artistIds) {
                            return undefined;
                        }
                        const cachedCount = await db.albums.count();
                        return cachedCount > 0 ? cachedCount : undefined;
                    },
                    queryKey: key,
                    remote: async ({ signal }) => {
                        const optimizedCount = await getOptimizedListCount<
                            ListCountQuery<AlbumListQuery>,
                            AlbumListQuery,
                            { totalRecordCount: null | number }
                        >({
                            client: ctx.client,
                            listQueryFn: controller.getAlbumList,
                            listQueryKeyFn: (serverId, query) =>
                                queryKeys.albums.list(serverId, query),
                            query: args.query,
                            serverId: args.serverId,
                            signal,
                        });

                        if (optimizedCount !== null) return optimizedCount;

                        return api.controller.getAlbumListCount({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        });
                    },
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
};
