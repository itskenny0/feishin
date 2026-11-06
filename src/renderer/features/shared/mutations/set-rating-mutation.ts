import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { useTranslation } from 'react-i18next';

import { queryKeys } from '/@/renderer/api/query-keys';
import { enqueueMutation } from '/@/renderer/cache';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import {
    applyItemOptimisticUpdates,
    PreviousQueryData,
    restoreQueryData,
} from '/@/renderer/features/shared/mutations/item-optimistic-updates';
import { MutationHookArgs } from '/@/renderer/lib/react-query';
import { toast } from '/@/shared/components/toast/toast';
import { LibraryItem, RatingResponse, SetRatingArgs } from '/@/shared/types/domain-types';

const setRatingMutationKey = ['set-rating'];

export const useSetRatingMutation = (args: MutationHookArgs) => {
    const { options } = args || {};
    const queryClient = useQueryClient();
    const { t } = useTranslation();

    return useMutation<RatingResponse, AxiosError, SetRatingArgs, PreviousQueryData[]>({
        mutationFn: async (args) => {
            await enqueueMutation('setRating', {
                ...args,
                apiClientProps: { serverId: args.apiClientProps.serverId },
            });
            return undefined;
        },
        mutationKey: setRatingMutationKey,
        onError: (error, _variables, context) => {
            // Re-emitting here would only re-apply the new rating: the event
            // carries one value for all ids, and their previous ratings differ.
            if (context) {
                restoreQueryData(queryClient, context);
            }

            toast.show({
                message: error.message,
                title: t('error.genericError') as string,
                type: 'error',
            });
        },
        onMutate: (variables) => {
            // Snapshot (and patch) the query cache before announcing the
            // change: list loaders write the event into their own queries
            // synchronously, and a snapshot taken after that can't undo it.
            const previous = applyItemOptimisticUpdates(
                queryClient,
                variables.apiClientProps.serverId,
                variables.query.id,
                variables.query.type,
                { userRating: variables.query.rating },
            );

            eventEmitter.emit('USER_RATING', {
                id: variables.query.id,
                itemType: variables.query.type,
                rating: variables.query.rating,
                serverId: variables.apiClientProps.serverId,
            });

            return previous;
        },
        onSuccess: (_data, variables) => {
            if (
                variables.query.type === LibraryItem.SONG ||
                variables.query.type === LibraryItem.PLAYLIST_SONG ||
                variables.query.type === LibraryItem.QUEUE_SONG
            ) {
                queryClient.invalidateQueries({
                    queryKey: queryKeys.albumArtists.favoriteSongs(
                        variables.apiClientProps.serverId,
                    ),
                });
            }
        },
        ...options,
    });
};

export const useIsMutatingRating = () => {
    const mutatingCount = useIsMutating({ mutationKey: setRatingMutationKey });
    return mutatingCount > 0;
};
