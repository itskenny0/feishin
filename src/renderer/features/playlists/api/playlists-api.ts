import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    getActiveCacheDb,
    isCacheAvailableSync,
    readSnapshot,
    toCachedPlaylistRow,
    writeSnapshot,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    ListCountQuery,
    PlaylistDetailQuery,
    PlaylistListQuery,
    PlaylistSongListQuery,
} from '/@/shared/types/domain-types';

export const playlistsQueries = {
    detail: (args: QueryHookArgs<PlaylistDetailQuery>) => {
        const key = queryKeys.playlists.detail(args.serverId, args.query.id, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                if (isCacheAvailableSync() && args.query?.id) {
                    try {
                        const db = getActiveCacheDb();
                        const row = await db?.playlists.get(args.query.id);
                        if (row?.Payload) writeSnapshot(key, row.Payload);
                    } catch {
                        /* swallow */
                    }
                }
                const fresh = await api.controller.getPlaylistDetail({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                if (isCacheAvailableSync() && fresh) {
                    try {
                        const db = getActiveCacheDb();
                        if (db) await db.playlists.put(toCachedPlaylistRow(fresh));
                    } catch {
                        /* swallow */
                    }
                }
                writeSnapshot(key, fresh);
                return fresh;
            },
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
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getPlaylistList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                if (isCacheAvailableSync()) {
                    try {
                        const db = getActiveCacheDb();
                        const items = fresh?.items ?? [];
                        if (db && items.length > 0) {
                            await db.playlists.bulkPut(items.map(toCachedPlaylistRow));
                        }
                    } catch {
                        /* swallow */
                    }
                }
                writeSnapshot(key, fresh);
                return fresh;
            },
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
            queryFn: async ({ signal }) => {
                if (isCacheAvailableSync()) {
                    try {
                        const db = getActiveCacheDb();
                        if (db) {
                            const cachedCount = await db.playlists.count();
                            if (cachedCount > 0) writeSnapshot(key, cachedCount);
                        }
                    } catch {
                        /* swallow */
                    }
                }
                const fresh = await api.controller.getPlaylistListCount({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
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
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getPlaylistSongList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
};
