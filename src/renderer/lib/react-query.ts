import type {
    DefaultOptions,
    QueryOptions,
    UseInfiniteQueryOptions,
    UseMutationOptions,
    UseQueryOptions,
} from '@tanstack/react-query';

import { QueryCache, QueryClient } from '@tanstack/react-query';
import i18n from 'i18next';

import { toast } from '/@/shared/components/toast/toast';

type ErrorCategory = 'auth' | 'network' | 'server' | 'unknown';

// Raw "Failed to <whatever>" controller strings are noisy and unhelpful for
// users. We classify by message contents and surface a single user-friendly
// line per category. Defaults are inlined so we never show an untranslated
// key if the locale file is older than this code.
const classifyError = (error: Error): { category: ErrorCategory; userMessage: string } => {
    const msg = error.message ?? '';
    const lowered = msg.toLowerCase();

    if (
        lowered.includes('failed to fetch') ||
        lowered.includes('load failed') ||
        lowered.includes('network') ||
        lowered.includes('econnrefused') ||
        lowered.includes('etimedout') ||
        lowered.includes('fetch')
    ) {
        return {
            category: 'network',
            userMessage: i18n.t('error.networkErrorFriendly', {
                defaultValue: 'Could not reach the server. Check your network and try again.',
            }),
        };
    }

    if (
        lowered.includes('unauthorized') ||
        lowered.includes('forbidden') ||
        lowered.includes('401') ||
        lowered.includes('403')
    ) {
        return {
            category: 'auth',
            userMessage: i18n.t('error.authError', {
                defaultValue: 'Your session may have expired. Try signing in again.',
            }),
        };
    }

    if (
        lowered.includes('500') ||
        lowered.includes('502') ||
        lowered.includes('503') ||
        lowered.includes('failed to')
    ) {
        return {
            category: 'server',
            userMessage: i18n.t('error.serverError', {
                defaultValue: 'The server had trouble with that request. Try again in a moment.',
            }),
        };
    }

    return {
        category: 'unknown',
        userMessage: msg || i18n.t('error.unknownError', { defaultValue: 'Something went wrong.' }),
    };
};

const queryCache = new QueryCache({
    onError: (error: any, query) => {
        if (query.state.data !== undefined) {
            // Keep the raw error in devtools so debugging isn't hindered by
            // the friendlier surface copy.
            console.error(error);
            const { userMessage } = classifyError(error as Error);
            toast.show({ message: userMessage, type: 'error' });
        }
    },
});

const queryConfig: DefaultOptions = {
    mutations: {
        retry: process.env.NODE_ENV === 'production' ? 3 : false,
    },
    queries: {
        // Cache list/detail responses long enough that re-entering a view
        // doesn't refetch. Real-time queries (e.g. now-playing) override
        // staleTime locally where shorter freshness is required.
        gcTime: 1000 * 60 * 30, // 30 minutes
        refetchOnWindowFocus: false,
        retry: process.env.NODE_ENV === 'production',
        staleTime: 1000 * 60 * 5, // 5 minutes
        throwOnError: (error: any) => {
            return error?.response?.status >= 500;
        },
    },
};

export const queryClient = new QueryClient({
    defaultOptions: queryConfig,
    queryCache,
});

export type InfiniteQueryHookArgs<T> = {
    options?: UseInfiniteQueryOptions;
    query: T;
    serverId: string | undefined;
};

export type MutationHookArgs = {
    options?: MutationOptions;
};

export type MutationOptions = {
    mutationKey: UseMutationOptions['mutationKey'];
    onError?: (err: any) => void;
    onSettled?: any;
    onSuccess?: any;
    retry?: UseQueryOptions['retry'];
    retryDelay?: UseQueryOptions['retryDelay'];
    useErrorBoundary?: boolean;
};

export type QueryHookArgs<T> = {
    options?: UseQueryHookOptions;
    query: T;
    serverId: string;
};

type UseQueryHookOptions = {
    enabled?: boolean;
    gcTime?: QueryOptions['gcTime'];
    // initialData?: UseQueryOptions['initialData'];
    // initialDataUpdatedAt?: UseQueryOptions['initialDataUpdatedAt'];
    meta?: UseQueryOptions['meta'];
    networkMode?: UseQueryOptions['networkMode'];
    notifyOnChangeProps?: UseQueryOptions['notifyOnChangeProps'];
    placeholderData?: (prev: any) => any;
    // queryFn?: UseQueryOptions['queryFn'];
    queryKey?: UseQueryOptions['queryKey'];
    queryKeyHashFn?: UseQueryOptions['queryKeyHashFn'];
    refetchInterval?: number;
    refetchIntervalInBackground?: UseQueryOptions['refetchIntervalInBackground'];
    refetchOnMount?: boolean;
    refetchOnReconnect?: boolean;
    refetchOnWindowFocus?: boolean;
    retry?: UseQueryOptions['retry'];
    retryDelay?: UseQueryOptions['retryDelay'];
    retryOnMount?: UseQueryOptions['retryOnMount'];
    // select?: UseQueryOptions['select'];
    staleTime?: number;
    structuralSharing?: UseQueryOptions['structuralSharing'];
    subscribed?: UseQueryOptions['subscribed'];
    throwOnError?: boolean;
};
