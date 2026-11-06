import { QueryClient, queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { dropSnapshotsForEntity, readSnapshot, snapshotSwr } from '/@/renderer/cache';
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

/**
 * Refetch the station list after a mutation. The snapshot goes first:
 * snapshotSwr would otherwise answer the refetch with the pre-mutation list,
 * and its throttled background revalidate may not run for up to a minute.
 */
export const invalidateRadioList = (queryClient: QueryClient, serverId: string | undefined) => {
    if (!serverId) return;
    dropSnapshotsForEntity('radio');
    queryClient.invalidateQueries({ queryKey: queryKeys.radio.list(serverId) });
};
