import { useEffect, useMemo, useRef, useState } from 'react';

import { ImageRequest } from '/@/shared/types/domain-types';

// The renderer registers a thumbnail resolver at startup. Shared code
// (this hook) lives in a bundle that doesn't have direct access to
// renderer-only modules, so we expose a tiny registration point and call
// through it. When the resolver isn't registered (test contexts, the
// shared bundle being imported elsewhere), the hook falls back to a plain
// network fetch.
type ThumbnailResolver = (
    itemId: string,
    size: number,
    request: ImageRequest | string,
) => Promise<string>;

let resolveThumbnailRef: null | ThumbnailResolver = null;

export const registerThumbnailResolver = (fn: null | ThumbnailResolver): void => {
    resolveThumbnailRef = fn;
};

const tryResolveThumbnail = async (
    itemId: string,
    size: number,
    request: ImageRequest,
): Promise<string | undefined> => {
    if (!resolveThumbnailRef) return undefined;
    try {
        const resolved = await resolveThumbnailRef(itemId, size, request);
        return resolved === request.url ? undefined : resolved;
    } catch {
        return undefined;
    }
};

type FetchPriority = 'auto' | 'high' | 'low';

interface NativeImageState {
    displaySrc?: string;
    status: 'error' | 'idle' | 'loaded' | 'loading';
}

interface UseNativeImageArgs {
    enabled: boolean;
    fetchPriority?: FetchPriority;
    onFetchError?: () => void;
    request?: ImageRequest | null;
}

export function useNativeImage({
    enabled,
    fetchPriority,
    onFetchError,
    request,
}: UseNativeImageArgs) {
    const abortControllerRef = useRef<AbortController | null>(null);
    const loadedRequestSignatureRef = useRef<null | string>(null);
    const objectUrlRef = useRef<null | string>(null);
    const onFetchErrorRef = useRef(onFetchError);
    const [state, setState] = useState<NativeImageState>({ status: 'idle' });

    const requestSignature = useMemo(() => {
        if (!request) {
            return null;
        }

        return JSON.stringify({
            cacheKey: request.cacheKey,
            credentials: request.credentials,
            headers: request.headers,
            url: request.url,
        });
    }, [request]);

    onFetchErrorRef.current = onFetchError;

    useEffect(() => {
        const abortCurrentRequest = () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
        };

        const revokeObjectUrl = () => {
            if (!objectUrlRef.current) {
                return;
            }

            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
            loadedRequestSignatureRef.current = null;
        };

        if (!request || !requestSignature) {
            abortCurrentRequest();
            revokeObjectUrl();
            setState({ status: 'idle' });
            return;
        }

        if (!enabled) {
            abortCurrentRequest();
            setState((currentState) =>
                currentState.displaySrc
                    ? { ...currentState, status: 'loaded' }
                    : { status: 'idle' },
            );
            return;
        }

        if (loadedRequestSignatureRef.current === requestSignature && objectUrlRef.current) {
            setState({ displaySrc: objectUrlRef.current, status: 'loaded' });
            return;
        }

        abortCurrentRequest();
        revokeObjectUrl();
        setState({ status: 'loading' });

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        void (async () => {
            try {
                // Dexie thumbnail cache first when the request carries an
                // explicit `cacheItemId`. resolveThumbnail returns a blob:
                // URL backed by the persistent table; on a cache miss it
                // fetches, writes Dexie, and returns the blob URL anyway,
                // so the subsequent network branch is a fall-back for
                // bundles where the cache module isn't available.
                if (request.cacheItemId && request.cacheSize) {
                    const cached = await tryResolveThumbnail(
                        request.cacheItemId,
                        request.cacheSize,
                        request,
                    );
                    if (abortController.signal.aborted) {
                        // The resolver creates a fresh blob: URL even on a
                        // cache hit. If the consumer unmounted while the
                        // resolver was in flight, revoke it before bailing
                        // so we don't leak the object URL.
                        if (cached && cached.startsWith('blob:')) {
                            URL.revokeObjectURL(cached);
                        }
                        return;
                    }
                    if (cached) {
                        objectUrlRef.current = cached;
                        loadedRequestSignatureRef.current = requestSignature;
                        setState({ displaySrc: cached, status: 'loaded' });
                        return;
                    }
                }

                const init = {
                    credentials: request.credentials,
                    headers: request.headers,
                    signal: abortController.signal,
                } as RequestInit & { priority?: FetchPriority };

                if (fetchPriority) {
                    init.priority = fetchPriority;
                }

                const response = await fetch(request.url, init);

                if (!response.ok) {
                    throw new Error(`Failed to load image: ${response.status}`);
                }

                const blob = await response.blob();

                if (abortController.signal.aborted) {
                    return;
                }

                const objectUrl = URL.createObjectURL(blob);
                objectUrlRef.current = objectUrl;
                loadedRequestSignatureRef.current = requestSignature;
                setState({ displaySrc: objectUrl, status: 'loaded' });
            } catch {
                if (abortController.signal.aborted) {
                    return;
                }

                revokeObjectUrl();
                setState({ status: 'error' });
                onFetchErrorRef.current?.();
            } finally {
                if (abortControllerRef.current === abortController) {
                    abortControllerRef.current = null;
                }
            }
        })();

        return () => {
            abortController.abort();

            if (abortControllerRef.current === abortController) {
                abortControllerRef.current = null;
            }
        };
    }, [enabled, fetchPriority, request, requestSignature]);

    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();

            if (objectUrlRef.current) {
                URL.revokeObjectURL(objectUrlRef.current);
            }
        };
    }, []);

    return {
        displaySrc: state.displaySrc,
        isError: state.status === 'error',
        isLoaded: state.status === 'loaded',
        isLoading: state.status === 'loading',
    };
}
