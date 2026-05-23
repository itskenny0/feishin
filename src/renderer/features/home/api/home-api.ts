import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { cachedSwr, readSnapshot, toCachedAlbumRow } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    AlbumListQuery,
    AlbumListResponse,
    AlbumListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

export const homeQueries = {
    recentlyPlayed: (args: QueryHookArgs<Partial<AlbumListQuery>>) => {
        const requestQuery: AlbumListQuery = {
            limit: 5,
            sortBy: AlbumListSort.RECENTLY_PLAYED,
            sortOrder: SortOrder.ASC,
            startIndex: 0,
            ...args.query,
        };
        const key = queryKeys.albums.list(args.serverId, requestQuery);

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
                    // Recently-played ordering is server-side state we can't
                    // reproduce locally without per-album lastPlayedAt being
                    // strictly current. Skip the Dexie read; snapshot map
                    // alone handles the cold-offline case via initialData.
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: requestQuery,
                        }) as Promise<AlbumListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
};
