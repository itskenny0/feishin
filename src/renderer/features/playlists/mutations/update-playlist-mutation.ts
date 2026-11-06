import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { dropCachedPlaylistSongs } from '/@/renderer/features/playlists/queries/playlists-queries';
import { MutationHookArgs } from '/@/renderer/lib/react-query';
import { UpdatePlaylistArgs, UpdatePlaylistResponse } from '/@/shared/types/domain-types';

export const useUpdatePlaylist = (args: MutationHookArgs) => {
    const { options } = args || {};
    const queryClient = useQueryClient();

    return useMutation<UpdatePlaylistResponse, AxiosError, UpdatePlaylistArgs, null>({
        mutationFn: (args) => {
            return api.controller.updatePlaylist({
                ...args,
                apiClientProps: { serverId: args.apiClientProps.serverId },
            });
        },
        onSuccess: async (_data, variables) => {
            const { apiClientProps, query } = variables;
            const serverId = apiClientProps.serverId;

            if (!serverId) return;

            // Smart-playlist rule changes alter the tracklist too.
            if (query?.id) await dropCachedPlaylistSongs(query.id);
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists.list(serverId),
            });

            if (query?.id) {
                queryClient.invalidateQueries({
                    queryKey: queryKeys.playlists.detail(serverId, query.id),
                });
                queryClient.invalidateQueries({
                    queryKey: queryKeys.playlists.songList(serverId, query.id),
                });
            }
        },
        ...options,
    });
};
