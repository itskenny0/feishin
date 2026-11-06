import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';

import { api } from '/@/renderer/api';
import { invalidateRadioList } from '/@/renderer/features/radio/api/radio-api';
import { MutationHookArgs } from '/@/renderer/lib/react-query';
import {
    DeleteInternetRadioStationArgs,
    DeleteInternetRadioStationResponse,
} from '/@/shared/types/domain-types';

export const useDeleteRadioStation = (args: MutationHookArgs) => {
    const { options } = args || {};
    const queryClient = useQueryClient();

    return useMutation<
        DeleteInternetRadioStationResponse,
        AxiosError,
        DeleteInternetRadioStationArgs,
        null
    >({
        mutationFn: (args) => {
            return api.controller.deleteInternetRadioStation({
                ...args,
                apiClientProps: { serverId: args.apiClientProps.serverId },
            });
        },
        onSuccess: (_args, variables) => {
            invalidateRadioList(queryClient, variables.apiClientProps.serverId);
        },
        ...options,
    });
};
