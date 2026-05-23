import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { getOptimizedListCount } from '/@/renderer/api/utils-list-count';
import {
    cachedSwr,
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
                        // Album is a structural subset of AlbumDetailResponse
                        // (missing `songs`). Consumers guard `.songs ?? []`
                        // so handing back the base Album is safe; the
                        // background revalidate fills in the songs.
                        return row?.Payload as AlbumDetailResponse | undefined;
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
                        if (
                            args.query.artistIds ||
                            args.query.genreIds ||
                            args.query.favorite !== undefined
                        ) {
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
