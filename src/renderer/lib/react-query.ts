import type {
    DefaultOptions,
    QueryOptions,
    UseInfiniteQueryOptions,
    UseMutationOptions,
    UseQueryOptions,
} from '@tanstack/react-query';

import { onlineManager, QueryCache, QueryClient } from '@tanstack/react-query';
import i18n from 'i18next';

import { CONNECTIVITY_EVENT, getIsOnline } from '/@/renderer/lib/network-status';
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

const MAX_QUERY_RETRIES = 3;
const MAX_MUTATION_RETRIES = 3;

// Retrying an auth (401/403) or not-found (404) error is pointless — the
// response won't change on a re-request and it just delays the friendly toast
// / re-auth flow. Mirrors the error classification in `cache/mutations.ts`
// (`isRetryable`) so the two retry systems agree on what's worth retrying.
const isAuthOrNotFound = (error: any): boolean => {
    const status = error?.response?.status;
    if (status === 401 || status === 403 || status === 404) {
        return true;
    }
    const lowered = (error?.message ?? '').toString().toLowerCase();
    return lowered.includes('unauthorized') || lowered.includes('forbidden');
};

// Jittered exponential backoff (1s, 2s, 4s … capped at 30s, ±25%), matching
// the durable mutation worker's `jitteredBackoffMs` so behaviour is consistent
// across both retry systems and concurrent failures don't synchronise.
let retryLogCounter = 0;
const jitteredRetryDelay = (attempt: number): number => {
    const delay = Math.round(Math.min(30_000, 1_000 * 2 ** attempt) * (0.75 + Math.random() * 0.5));
    // Sampled so a network outage doesn't flood the console.
    if (retryLogCounter++ % 8 === 0) {
        console.info('[net] retry attempt %d after %dms', attempt + 1, delay);
    }
    return delay;
};

const queryConfig: DefaultOptions = {
    mutations: {
        retry: (failureCount, error) => {
            if (process.env.NODE_ENV !== 'production') {
                return false;
            }
            if (isAuthOrNotFound(error)) {
                return false;
            }
            return failureCount < MAX_MUTATION_RETRIES;
        },
        retryDelay: jitteredRetryDelay,
    },
    queries: {
        // Cache list/detail responses long enough that re-entering a view
        // doesn't refetch. Real-time queries (e.g. now-playing) override
        // staleTime locally where shorter freshness is required.
        gcTime: 1000 * 60 * 30, // 30 minutes
        // With networkMode left at the default 'online', paused queries
        // auto-refetch when our onlineManager flips back to online (below).
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
            if (process.env.NODE_ENV !== 'production') {
                return false;
            }
            if (isAuthOrNotFound(error)) {
                return false;
            }
            return failureCount < MAX_QUERY_RETRIES;
        },
        retryDelay: jitteredRetryDelay,
        staleTime: 1000 * 60 * 5, // 5 minutes
        throwOnError: (error: any) => {
            return error?.response?.status >= 500;
        },
    },
};

// Drive TanStack's pause/resume from our combined connectivity signal
// (navigator.onLine AND server-reachability) rather than navigator.onLine
// alone, which lies on Electron/WebView when the server is unreachable. When
// this flips back to online, queries with refetchOnReconnect auto-refetch and
// paused mutations resume.
onlineManager.setEventListener((setOnline) => {
    const handler = () => setOnline(getIsOnline());
    if (typeof window === 'undefined') {
        setOnline(true);
        return () => {};
    }
    window.addEventListener(CONNECTIVITY_EVENT, handler);
    window.addEventListener('online', handler);
    window.addEventListener('offline', handler);
    // Seed the manager with the current snapshot.
    setOnline(getIsOnline());
    return () => {
        window.removeEventListener(CONNECTIVITY_EVENT, handler);
        window.removeEventListener('online', handler);
        window.removeEventListener('offline', handler);
    };
});

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
