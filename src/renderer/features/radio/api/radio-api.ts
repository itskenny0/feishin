import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { readSnapshot, writeSnapshot } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';

export const radioQueries = {
    list: (args: QueryHookArgs<void>) => {
        const key = queryKeys.radio.list(args.serverId || '');
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getInternetRadioStations({
                    apiClientProps: { serverId: args.serverId, signal },
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
};
