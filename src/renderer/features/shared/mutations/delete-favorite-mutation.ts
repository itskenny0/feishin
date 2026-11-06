import { useIsMutating } from '@tanstack/react-query';

import {
    favoriteMutationKey,
    useFavoriteMutation,
} from '/@/renderer/features/shared/mutations/create-favorite-mutation';
import { MutationHookArgs } from '/@/renderer/lib/react-query';

export const useDeleteFavorite = (args: MutationHookArgs) => useFavoriteMutation(false, args);

export const useIsMutatingDeleteFavorite = () =>
    useIsMutating({ mutationKey: favoriteMutationKey(false) }) > 0;
