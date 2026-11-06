import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    cachedSwr,
    filterPlaylistsLocal,
    readEntityCountFallback,
    readSnapshot,
    toCachedPlaylistRow,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    ListCountQuery,
    PlaylistListQuery,
    PlaylistListResponse,
} from '/@/shared/types/domain-types';

export const playlistsQueries = {
    list: (args: QueryHookArgs<PlaylistListQuery>) => {
        const key = queryKeys.playlists.list(args.serverId || '', args.query);
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<PlaylistListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.playlists.bulkPut(items.map(toCachedPlaylistRow));
                        }
                    },
                    ctx,
                    fromCache: async (db) => {
                        const rows = await db.playlists.toArray();
                        if (rows.length === 0) return undefined;
                        return filterPlaylistsLocal({ query: args.query, rows }) ?? undefined;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getPlaylistList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<PlaylistListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    listCount: (args: QueryHookArgs<ListCountQuery<PlaylistListQuery>>) => {
        const key = queryKeys.playlists.count(
            args.serverId || '',
            Object.keys(args.query).length === 0 ? undefined : args.query,
        );
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readEntityCountFallback(key, 'playlists')) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
                        if (args.query.searchTerm) {
                            const rows = await db.playlists.toArray();
                            const result = filterPlaylistsLocal({
                                query: { ...args.query, startIndex: 0 },
                                rows,
                            });
                            if (result !== undefined) return result.totalRecordCount ?? 0;
                        }
                        const cachedCount = await db.playlists.count();
                        return cachedCount > 0 ? cachedCount : undefined;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getPlaylistListCount({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }),
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
};
