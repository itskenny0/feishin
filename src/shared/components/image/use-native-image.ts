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
    variant: string,
    request: ImageRequest | string,
) => Promise<string>;

// Refcounted shared-URL pair. When registered, the hook prefers these over
// the per-call `resolveThumbnailRef` so concurrent mounts of the same item
// share ONE object URL (revoked only when the last consumer releases it),
// instead of each mount minting + revoking its own blob: URL during scroll.
type ThumbnailUrlAcquirer = (
    itemId: string,
    variant: string,
    request: ImageRequest | string,
) => Promise<string>;
// Synchronous peek: returns a live shared blob: URL (taking a reference the
// caller must release) when the cover is already held in memory, undefined
// otherwise. Lets an already-cached cover paint with NO loading state.
type ThumbnailUrlPeeker = (itemId: string, variant: string) => string | undefined;
// Non-acquiring membership probe: true when a live shared URL exists for the
// (item, variant). Takes NO reference — purely a hint for consumers (e.g.
// `<BaseImage>` skipping its load debounce / viewport wait when the cover
// would paint synchronously anyway).
type ThumbnailUrlProber = (itemId: string, variant: string) => boolean;
// The releaser MUST be keyed by the SAME (itemId, variant) the URL was
// acquired with — two surfaces of one item at different variants each own
// their own shared URL + refcount. Releasing by bare itemId would
// decrement (and prematurely revoke) the wrong variant's entry.
type ThumbnailUrlReleaser = (itemId: string, variant: string) => void;

// Surface bucket used when a request doesn't declare one (legacy callers,
// the `imageUrl` branch, or anything that hasn't threaded a `type` through).
// Matches the resolver's own DEFAULT_VARIANT — the full-resolution cover.
const DEFAULT_VARIANT = 'fullScreen';

let resolveThumbnailRef: null | ThumbnailResolver = null;
let acquireThumbnailUrlRef: null | ThumbnailUrlAcquirer = null;
let releaseThumbnailUrlRef: null | ThumbnailUrlReleaser = null;
let peekThumbnailUrlRef: null | ThumbnailUrlPeeker = null;
let probeThumbnailUrlRef: null | ThumbnailUrlProber = null;

export const registerThumbnailResolver = (fn: null | ThumbnailResolver): void => {
    resolveThumbnailRef = fn;
};

export const registerThumbnailUrlCache = (
    acquire: null | ThumbnailUrlAcquirer,
    release: null | ThumbnailUrlReleaser,
    peek: null | ThumbnailUrlPeeker = null,
    probe: null | ThumbnailUrlProber = null,
): void => {
    acquireThumbnailUrlRef = acquire;
    releaseThumbnailUrlRef = release;
    peekThumbnailUrlRef = peek;
    probeThumbnailUrlRef = probe;
};

/**
 * True when a live shared blob: URL is already held in memory for this
 * (item, variant) — i.e. `useNativeImage` would paint it synchronously via
 * the peek fast path with no async hop. Never takes a reference. Consumers
 * use it to skip first-load niceties (debounce, viewport gating) that only
 * make sense when the image would otherwise hit Dexie or the network.
 */
export const hasSharedThumbnailUrl = (itemId: string, variant?: string): boolean =>
    probeThumbnailUrlRef?.(itemId, variant ?? DEFAULT_VARIANT) ?? false;

// Resolve via the shared refcounted cache when available. Returns the
// shared (already-refcounted) URL on a hit, or undefined on a miss so the
// caller falls through to a direct fetch. The caller owns releasing the
// returned URL's refcount via `releaseSharedThumbnailUrl`.
const tryAcquireSharedThumbnail = async (
    itemId: string,
    variant: string,
    request: ImageRequest,
): Promise<string | undefined> => {
    if (!acquireThumbnailUrlRef) return undefined;
    try {
        const resolved = await acquireThumbnailUrlRef(itemId, variant, request);
        return resolved === request.url ? undefined : resolved;
    } catch {
        return undefined;
    }
};

const releaseSharedThumbnailUrl = (itemId: string, variant: string): void => {
    releaseThumbnailUrlRef?.(itemId, variant);
};

const tryResolveThumbnail = async (
    itemId: string,
    variant: string,
    request: ImageRequest,
): Promise<string | undefined> => {
    if (!resolveThumbnailRef) return undefined;
    try {
        const resolved = await resolveThumbnailRef(itemId, variant, request);
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
    // another mounted consumer of the same (item, variant) may still be
    // displaying the same blob: URL. Holds the (itemId, variant) whose
    // refcount we own, or null when objectUrlRef is a self-minted
    // (fetch->blob) URL we must revoke. The variant MUST match what we
    // acquired with so we release the correct shared entry.
    const sharedUrlRef = useRef<null | { itemId: string; variant: string }>(null);
    const onFetchErrorRef = useRef(onFetchError);
    const [state, setState] = useState<NativeImageState>({ status: 'idle' });

    // STABLE signature of the request. Deliberately omits volatile /
    // identity-only fields: when `home` renders from a snapshot and then
    // react-query swaps in a fresh data array, the `request` OBJECT is a
    // new identity but the URL / cache key / variant are unchanged. Keying
    // the resolve effect off this string (instead of the object) means an
    // identity-only change does NOT tear down an already-correct image and
    // re-resolve it from skeleton ("instant then slow redraw").
    const requestSignature = useMemo(() => {
        if (!request) {
            return null;
        }

        return JSON.stringify({
            cacheItemId: request.cacheItemId,
            cacheKey: request.cacheKey,
            cacheSize: request.cacheSize,
            credentials: request.credentials,
            headers: request.headers,
            url: request.url,
            variant: request.variant,
        });
    }, [request]);

    // Latest `request` object, read inside the resolve effect WITHOUT making
    // the effect depend on its identity. The effect is gated on
    // `requestSignature` (stable) instead, so a new object carrying the same
    // signature reuses the in-flight / loaded image rather than restarting.
    const requestRef = useRef(request);
    requestRef.current = request;

    onFetchErrorRef.current = onFetchError;

    useEffect(() => {
        // Read the latest request via the ref so this effect's behaviour is
        // gated purely on the STABLE `requestSignature` (dep array below),
        // not on the request object's identity.
        const request = requestRef.current;

        const abortCurrentRequest = () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
        };

        const revokeObjectUrl = () => {
            if (!objectUrlRef.current) {
                return;
            }

            if (sharedUrlRef.current) {
                // Shared refcounted URL: release our reference instead of
                // revoking — the cache revokes once the last consumer lets
                // go. Release by the SAME (item, variant) we acquired with.
                releaseSharedThumbnailUrl(
                    sharedUrlRef.current.itemId,
                    sharedUrlRef.current.variant,
                );
                sharedUrlRef.current = null;
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

        // Synchronous fast path: a cover already held in the shared memory
        // cache (including the zero-ref grace window) paints immediately —
        // no skeleton state, no async hop, no Dexie roundtrip. The peek
        // takes a reference that revokeObjectUrl/unmount releases.
        if (request.cacheItemId && request.cacheSize && peekThumbnailUrlRef) {
            const cacheVariant = request.variant ?? DEFAULT_VARIANT;
            const peeked = peekThumbnailUrlRef(request.cacheItemId, cacheVariant);
            if (peeked) {
                objectUrlRef.current = peeked;
                sharedUrlRef.current = { itemId: request.cacheItemId, variant: cacheVariant };
                loadedRequestSignatureRef.current = requestSignature;
                setState({ displaySrc: peeked, status: 'loaded' });
                return;
            }
        }

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
                    // The surface bucket selects which pre-sized cover the
                    // resolver serves (schema v11 keys `[itemId, variant]`).
                    // `ItemImage` threads its `type` through as `variant`;
                    // anything without one collapses to the full-res cover.
                    const cacheVariant = request.variant ?? DEFAULT_VARIANT;
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
                        ? tryAcquireSharedThumbnail(cacheItemId, cacheVariant, request)
                        : tryResolveThumbnail(cacheItemId, cacheVariant, request);
                    if (useShared) {
                        void lookupPromise.then((late) => {
                            // If the 5s cap won the race but we ALSO already
                            // adopted the late result below, don't release it
                            // (that would revoke a URL we're displaying). Only
                            // release when it arrived after the timeout AND we
                            // never adopted it.
                            if (
                                timedOut &&
                                late &&
                                late.startsWith('blob:') &&
                                objectUrlRef.current !== late
                            ) {
                                releaseSharedThumbnailUrl(cacheItemId, cacheVariant);
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
                                releaseSharedThumbnailUrl(cacheItemId, cacheVariant);
                            } else {
                                URL.revokeObjectURL(cached);
                            }
                        }
                        return;
                    }
                    if (cached) {
                        objectUrlRef.current = cached;
                        sharedUrlRef.current = useShared
                            ? { itemId: cacheItemId, variant: cacheVariant }
                            : null;
                        loadedRequestSignatureRef.current = requestSignature;
                        setState({ displaySrc: cached, status: 'loaded' });
                        return;
                    }
                    // Cache lookup lost the 5s race (timedOut) but the
                    // resolver may still be in flight (e.g. awaiting a shared
                    // sweep task). Do NOT drop an already-correct displayed
                    // image back to skeleton: if we already have a loaded
                    // object URL keep showing it and let the late `.then`
                    // above reconcile. Only fall through to a direct network
                    // fetch when nothing is currently displayed.
                    if (timedOut && objectUrlRef.current) {
                        setState({ displaySrc: objectUrlRef.current, status: 'loaded' });
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
                sharedUrlRef.current = null;
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
        // Gated on the STABLE `requestSignature`, NOT on the `request`
        // object identity. A new request object carrying the same signature
        // (the home snapshot → react-query swap) is a no-op for this effect,
        // so an already-loaded image is never torn down and re-resolved.
    }, [enabled, fetchPriority, requestSignature]);

    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();

            if (objectUrlRef.current) {
                if (sharedUrlRef.current) {
                    releaseSharedThumbnailUrl(
                        sharedUrlRef.current.itemId,
                        sharedUrlRef.current.variant,
                    );
                    sharedUrlRef.current = null;
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
