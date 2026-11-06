import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { dropCachedPlaylistSongs } from '/@/renderer/features/playlists/queries/playlists-queries';
import { MutationOptions } from '/@/renderer/lib/react-query';
import { RemoveFromPlaylistArgs, RemoveFromPlaylistResponse } from '/@/shared/types/domain-types';

export const useRemoveFromPlaylist = (options?: MutationOptions) => {
    const queryClient = useQueryClient();

    return useMutation<RemoveFromPlaylistResponse, AxiosError, RemoveFromPlaylistArgs, null>({
        mutationFn: (args) => {
            return api.controller.removeFromPlaylist({
                ...args,
                apiClientProps: { serverId: args.apiClientProps.serverId },
            });
        },
        onSuccess: async (_data, variables) => {
            const { apiClientProps } = variables;
            const serverId = apiClientProps.serverId;

            if (!serverId) return;

            await dropCachedPlaylistSongs(variables.query.id);
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists.list(serverId),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists.detail(serverId, variables.query.id),
            });
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists.songList(serverId, variables.query.id),
            });
            // Else the skip-duplicates check still sees the removed songs and
            // refuses to add them back.
            queryClient.invalidateQueries({
                queryKey: queryKeys.playlists.songListIds(serverId, variables.query.id),
            });
        },
        ...options,
    });
};
