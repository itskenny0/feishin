import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';

import { api } from '/@/renderer/api';
import { invalidateRadioList } from '/@/renderer/features/radio/api/radio-api';
import { MutationHookArgs } from '/@/renderer/lib/react-query';
import {
    UpdateInternetRadioStationArgs,
    UpdateInternetRadioStationResponse,
} from '/@/shared/types/domain-types';

export const useUpdateRadioStation = (args: MutationHookArgs) => {
    const { options } = args || {};
    const queryClient = useQueryClient();

    return useMutation<
        UpdateInternetRadioStationResponse,
        AxiosError,
        UpdateInternetRadioStationArgs,
        null
    >({
        mutationFn: (args) => {
            return api.controller.updateInternetRadioStation({
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
