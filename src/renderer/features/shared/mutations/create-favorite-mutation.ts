import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import isElectron from 'is-electron';
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
import { FavoriteArgs, FavoriteResponse, LibraryItem } from '/@/shared/types/domain-types';

const remote = isElectron() ? window.api.remote : null;

const SONG_ITEM_TYPES = new Set([
    LibraryItem.PLAYLIST_SONG,
    LibraryItem.QUEUE_SONG,
    LibraryItem.SONG,
]);

export const favoriteMutationKey = (isFavorite: boolean) => ['set-favorite', isFavorite];

const emitFavorite = (variables: FavoriteArgs, favorite: boolean) =>
    eventEmitter.emit('USER_FAVORITE', {
        favorite,
        id: variables.query.id,
        itemType: variables.query.type,
        serverId: variables.apiClientProps.serverId,
    });

/** Shared implementation of the add (`isFavorite`) / remove favorite mutations. */
export const useFavoriteMutation = (isFavorite: boolean, args: MutationHookArgs) => {
    const { options } = args || {};
    const queryClient = useQueryClient();
    const { t } = useTranslation();

    return useMutation<FavoriteResponse, AxiosError, FavoriteArgs, PreviousQueryData[]>({
        mutationFn: async (args) => {
            await enqueueMutation(isFavorite ? 'createFavorite' : 'deleteFavorite', {
                ...args,
                apiClientProps: { serverId: args.apiClientProps.serverId },
            });
            return undefined;
        },
        mutationKey: favoriteMutationKey(isFavorite),
        onError: (error, variables, context) => {
            if (context) {
                restoreQueryData(queryClient, context);
            }

            toast.show({
                message: error.message,
                title: t('error.genericError') as string,
                type: 'error',
            });

            emitFavorite(variables, !isFavorite);
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
                { userFavorite: isFavorite },
            );

            emitFavorite(variables, isFavorite);

            return previous;
        },
        onSuccess: (_data, variables) => {
            const { serverId } = variables.apiClientProps;
            if (!SONG_ITEM_TYPES.has(variables.query.type)) return;
            remote?.updateFavorite(isFavorite, serverId, variables.query.id);
            queryClient.invalidateQueries({
                queryKey: queryKeys.albumArtists.favoriteSongs(serverId),
            });
        },
        ...options,
    });
};

export const useCreateFavorite = (args: MutationHookArgs) => useFavoriteMutation(true, args);

export const useIsMutatingCreateFavorite = () =>
    useIsMutating({ mutationKey: favoriteMutationKey(true) }) > 0;
