import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';

import { api } from '/@/renderer/api';
import { invalidateRadioList } from '/@/renderer/features/radio/api/radio-api';
import { MutationHookArgs } from '/@/renderer/lib/react-query';
import {
    DeleteInternetRadioStationImageArgs,
    DeleteInternetRadioStationImageResponse,
} from '/@/shared/types/domain-types';

export const useDeleteInternetRadioStationImage = (args: MutationHookArgs) => {
    const { options } = args || {};
    const queryClient = useQueryClient();

    return useMutation<
        DeleteInternetRadioStationImageResponse,
        AxiosError,
        DeleteInternetRadioStationImageArgs,
        null
    >({
        mutationFn: (args) => {
            return api.controller.deleteInternetRadioStationImage({
                ...args,
                apiClientProps: { serverId: args.apiClientProps.serverId },
            });
        },
        onSuccess: (_data, variables) => {
            invalidateRadioList(queryClient, variables.apiClientProps.serverId);
        },
        ...options,
    });
};
