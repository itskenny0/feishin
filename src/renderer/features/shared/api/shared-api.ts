import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { readSnapshot, snapshotSwr } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    MusicFolderListQuery,
    MusicFolderListResponse,
    TagListQuery,
    TagListResponse,
    UserListQuery,
    UserListResponse,
} from '/@/shared/types/domain-types';

// Lightweight sidecar lists (music folders, roles, tag enums, user list)
// don't have their own Dexie tables — they're small, mostly-static, and
// fetched once per session per server. Snapshot-map persistence is enough
// to make every UI surface that opens a filter dropdown paint from cache
// before the network round-trip lands.

type RolesResponse = Array<string | { label: string; value: string }>;

export const sharedQueries = {
    musicFolders: (args: QueryHookArgs<MusicFolderListQuery>) => {
        const key = queryKeys.musicFolders.list(args.serverId);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<MusicFolderListResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getMusicFolderList({
                            apiClientProps: { serverId: args.serverId, signal },
                        }) as Promise<MusicFolderListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    roles: (args: QueryHookArgs<object>) => {
        const key = queryKeys.roles.list(args.serverId || '');
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<RolesResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getRoles({
                            apiClientProps: { serverId: args.serverId, signal },
                        }) as Promise<RolesResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    scanStatus: (args: QueryHookArgs<null>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getScanStatus({
                    apiClientProps: { serverId: args.serverId, signal },
                });
            },
            queryKey: queryKeys.server.scanStatus(args.serverId),
            ...args.options,
        });
    },
    tagList: (args: QueryHookArgs<TagListQuery>) => {
        const key = queryKeys.tags.list(args.serverId || '', args.query.type);
        return queryOptions({
            gcTime: 1000 * 60 * 24,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<TagListResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getTagList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<TagListResponse>,
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 24,
            structuralSharing: false,
            ...args.options,
        });
    },
    users: (args: QueryHookArgs<UserListQuery>) => {
        const key = queryKeys.users.list(args.serverId || '', args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<UserListResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getUserList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<UserListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
};
