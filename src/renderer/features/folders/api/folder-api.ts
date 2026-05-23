import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { readSnapshot, writeSnapshot } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import { FolderQuery } from '/@/shared/types/domain-types';

export const folderQueries = {
    folder: (args: QueryHookArgs<FolderQuery>) => {
        const key = queryKeys.folders.folder(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getFolder({
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
