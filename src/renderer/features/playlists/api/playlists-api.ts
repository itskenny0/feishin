import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { cachedSwr, readSnapshot, snapshotSwr, toCachedPlaylistRow } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    ListCountQuery,
    Playlist,
    PlaylistDetailQuery,
    PlaylistListQuery,
    PlaylistListResponse,
    PlaylistSongListQuery,
    PlaylistSongListResponse,
} from '/@/shared/types/domain-types';

export const playlistsQueries = {
    detail: (args: QueryHookArgs<PlaylistDetailQuery>) => {
        const key = queryKeys.playlists.detail(args.serverId, args.query.id, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<Playlist>({
                    apply: async (db, fresh) => {
                        if (!fresh) return;
                        await db.playlists.put(toCachedPlaylistRow(fresh));
                    },
                    ctx,
                    fromCache: async (db) => {
                        if (!args.query?.id) return undefined;
                        const row = await db.playlists.get(args.query.id);
                        return row?.Payload;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getPlaylistDetail({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<Playlist>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
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
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
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
    songList: (args: QueryHookArgs<PlaylistSongListQuery>) => {
        const key = queryKeys.playlists.songList(args.serverId || '', args.query.id);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<PlaylistSongListResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getPlaylistSongList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<PlaylistSongListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
};
