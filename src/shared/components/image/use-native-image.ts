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

// Refcounted shared-URL pair. When registered, the hook prefers these over
// the per-call `resolveThumbnailRef` so concurrent mounts of the same item
// share ONE object URL (revoked only when the last consumer releases it),
// instead of each mount minting + revoking its own blob: URL during scroll.
type ThumbnailUrlAcquirer = (
    itemId: string,
    size: number,
    request: ImageRequest | string,
) => Promise<string>;
type ThumbnailUrlReleaser = (itemId: string) => void;

let resolveThumbnailRef: null | ThumbnailResolver = null;
let acquireThumbnailUrlRef: null | ThumbnailUrlAcquirer = null;
let releaseThumbnailUrlRef: null | ThumbnailUrlReleaser = null;

export const registerThumbnailResolver = (fn: null | ThumbnailResolver): void => {
    resolveThumbnailRef = fn;
};

export const registerThumbnailUrlCache = (
    acquire: null | ThumbnailUrlAcquirer,
    release: null | ThumbnailUrlReleaser,
): void => {
    acquireThumbnailUrlRef = acquire;
    releaseThumbnailUrlRef = release;
};

// Resolve via the shared refcounted cache when available. Returns the
// shared (already-refcounted) URL on a hit, or undefined on a miss so the
// caller falls through to a direct fetch. The caller owns releasing the
// returned URL's refcount via `releaseSharedThumbnailUrl`.
const tryAcquireSharedThumbnail = async (
    itemId: string,
    size: number,
    request: ImageRequest,
): Promise<string | undefined> => {
    if (!acquireThumbnailUrlRef) return undefined;
    try {
        const resolved = await acquireThumbnailUrlRef(itemId, size, request);
        return resolved === request.url ? undefined : resolved;
    } catch {
        return undefined;
    }
};

const releaseSharedThumbnailUrl = (itemId: string): void => {
    releaseThumbnailUrlRef?.(itemId);
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
    // When the current objectUrl came from the shared refcounted cache we
    // release it (decrement refcount) rather than revoking it directly —
    // another mounted consumer of the same item may still be displaying
    // the same blob: URL. Holds the itemId whose refcount we own, or null
    // when objectUrlRef is a self-minted (fetch->blob) URL we must revoke.
    const sharedUrlItemIdRef = useRef<null | string>(null);
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

            if (sharedUrlItemIdRef.current) {
                // Shared refcounted URL: release our reference instead of
                // revoking — the cache revokes once the last consumer lets
                // go.
                releaseSharedThumbnailUrl(sharedUrlItemIdRef.current);
                sharedUrlItemIdRef.current = null;
            } else {
                URL.revokeObjectURL(objectUrlRef.current);
            }
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
                    // Prefer the shared refcounted cache so concurrent
                    // mounts of the same item reuse ONE object URL. Falls
                    // back to the per-call resolver when the shared cache
                    // isn't registered (e.g. the shared bundle imported
                    // outside the renderer).
                    const useShared = Boolean(acquireThumbnailUrlRef);
                    const cacheItemId = request.cacheItemId;
                    // Race the cache lookup against a 5s cap. The lookup
                    // may await a shared in-flight promise from the thumbnail
                    // sweep (which has its own 20s network timeout); without
                    // the race the image component spins for up to 20s before
                    // the sweep task resolves and we can fall through to a
                    // direct fetch.
                    let timedOut = false;
                    const cacheTimeout = new Promise<undefined>((resolve) => {
                        setTimeout(() => {
                            timedOut = true;
                            resolve(undefined);
                        }, 5_000);
                    });
                    // Keep the acquire promise around so that if the 5s cap
                    // wins the race we can still release the (shared) ref it
                    // eventually acquires — otherwise the refcount leaks and
                    // the blob: URL is never revoked.
                    const lookupPromise = useShared
                        ? tryAcquireSharedThumbnail(cacheItemId, request.cacheSize, request)
                        : tryResolveThumbnail(cacheItemId, request.cacheSize, request);
                    if (useShared) {
                        void lookupPromise.then((late) => {
                            if (timedOut && late && late.startsWith('blob:')) {
                                releaseSharedThumbnailUrl(cacheItemId);
                            }
                        });
                    }
                    const cached = await Promise.race([lookupPromise, cacheTimeout]);
                    if (abortController.signal.aborted) {
                        // The resolver hands back a blob: URL even on a
                        // cache hit. If the consumer unmounted while the
                        // resolver was in flight, release/revoke it before
                        // bailing so we don't leak the object URL.
                        if (cached && cached.startsWith('blob:')) {
                            if (useShared) {
                                releaseSharedThumbnailUrl(cacheItemId);
                            } else {
                                URL.revokeObjectURL(cached);
                            }
                        }
                        return;
                    }
                    if (cached) {
                        objectUrlRef.current = cached;
                        sharedUrlItemIdRef.current = useShared ? cacheItemId : null;
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
                sharedUrlItemIdRef.current = null;
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
                if (sharedUrlItemIdRef.current) {
                    releaseSharedThumbnailUrl(sharedUrlItemIdRef.current);
                    sharedUrlItemIdRef.current = null;
                } else {
                    URL.revokeObjectURL(objectUrlRef.current);
                }
                objectUrlRef.current = null;
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
