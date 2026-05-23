import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { readSnapshot, snapshotSwr } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import { GetInternetRadioStationsResponse } from '/@/shared/types/domain-types';

export const radioQueries = {
    list: (args: QueryHookArgs<void>) => {
        const key = queryKeys.radio.list(args.serverId || '');
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<GetInternetRadioStationsResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getInternetRadioStations({
                            apiClientProps: { serverId: args.serverId, signal },
                        }) as Promise<GetInternetRadioStationsResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
};
