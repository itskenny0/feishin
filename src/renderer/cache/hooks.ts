import type { InfiniteData, QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { LibraryCacheDb } from './db';

import { getActiveCacheDb } from './db';
import { readSnapshot, writeSnapshot } from './snapshot';
import { useCacheStore } from './store';

import { queryClient } from '/@/renderer/lib/react-query';

const activeDb = (): LibraryCacheDb | undefined =>
    useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;

// Per-queryKey throttle map for background revalidates. After a
// successful bg refetch we record the timestamp and skip subsequent
// bg revalidates from the same queryKey for `REVALIDATE_TTL_MS`. This
// stops large-album / large-playlist surfaces from refetching the
// entire payload every time the user navigates to them within a
// session — the cached value is more than fresh enough.
const lastRevalidateAt = new Map<string, number>();
const REVALIDATE_TTL_MS = 60_000;

const shouldRevalidate = (queryKey: QueryKey): boolean => {
    const hash = JSON.stringify(queryKey);
    const last = lastRevalidateAt.get(hash) ?? 0;
    if (Date.now() - last < REVALIDATE_TTL_MS) return false;
    lastRevalidateAt.set(hash, Date.now());
    return true;
};

// Sentinel returned by remote() when the network call fails and we want
// the cold path to resolve with a known-empty value (so Suspense doesn't
// hang and the consumer's offline-safe render path can take over). We
// use `null` rather than an entity-shaped empty because non-list queries
// (detail / count / info) have a sensible null state.
const isLikelyNetworkError = (err: unknown): boolean => {
    const name = (err as Error)?.name;
    const message = (err as Error)?.message ?? '';
    if (name === 'AbortError') return false;
    return (
        name === 'TypeError' ||
        name === 'NetworkError' ||
        /network|fetch|offline|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(message)
    );
};

/**
 * Snapshot-only SWR runner for queries that don't have a Dexie table to
 * fall back on (sidecar lists, etc.). Same shape as `cachedSwr` minus
 * the Dexie hooks. Cold network failures resolve with `null` (cast to
 * TData) so Suspense ends and offline-safe consumers see an empty
 * state instead of a thrown error.
 */
export const snapshotSwr = async <TData>(args: {
    ctx: QueryFunctionContext;
    queryKey: QueryKey;
    remote: (ctx: QueryFunctionContext) => Promise<TData>;
}): Promise<TData> => {
    const { ctx, queryKey, remote } = args;
    const cached = readSnapshot<TData>(queryKey);
    if (cached !== undefined) {
        if (shouldRevalidate(queryKey)) {
            void (async () => {
                try {
                    const fresh = await remote(ctx);
                    writeSnapshot(queryKey, fresh);
                    queryClient.setQueryData(queryKey, fresh);
                } catch (err) {
                    if ((err as Error)?.name !== 'AbortError') {
                        console.info('[cache] background revalidate failed', queryKey, err);
                    }
                }
            })();
        }
        return cached;
    }
    try {
        const fresh = await remote(ctx);
        writeSnapshot(queryKey, fresh);
        return fresh;
    } catch (err) {
        if (isLikelyNetworkError(err)) {
            console.info('[cache] cold network failed; returning null', queryKey, {
                error: (err as Error)?.message,
            });
            return null as unknown as TData;
        }
        throw err;
    }
};

/**
 * Stale-while-revalidate runner shared by `useCachedQuery`,
 * `useCachedInfiniteQuery`, and every cross-feature `queryOptions`
 * factory. When the cache holds a value we return it IMMEDIATELY (so
 * Suspense ends, consumers see real data, and an offline session keeps
 * working) and fire the network call in the background as a fire-and-
 * forget revalidation. Failures (offline, 500, etc.) leave the cached
 * value in place. On a true cache miss we fall through to the network
 * exactly as before, and a failed network call propagates so the
 * surface's error boundary handles it.
 */
export const cachedSwr = async <TData>(args: {
    apply?: (db: LibraryCacheDb, fresh: TData) => Promise<void>;
    ctx: QueryFunctionContext;
    fromCache?: (db: LibraryCacheDb) => Promise<TData | undefined>;
    queryKey: QueryKey;
    remote: (ctx: QueryFunctionContext) => Promise<TData>;
}): Promise<TData> => {
    const { apply, ctx, fromCache, queryKey, remote } = args;
    const db = activeDb();

    let cached: TData | undefined;
    if (db && fromCache) {
        try {
            cached = await fromCache(db);
            if (cached !== undefined) writeSnapshot(queryKey, cached);
        } catch (err) {
            console.warn('[cache] fromCache failed', queryKey, err);
        }
    }

    if (cached !== undefined) {
        // Background revalidate — never awaited AND throttled per
        // queryKey. The user already has their data, so a slow or
        // failed network call must not block the render or throw out
        // of queryFn. The throttle prevents large-album / large-
        // playlist re-renders every time the user re-enters the page
        // within the TTL window.
        if (shouldRevalidate(queryKey)) {
            void (async () => {
                try {
                    const fresh = await remote(ctx);
                    // Defensive: skip setQueryData if the network came
                    // back with something less useful than what's
                    // cached. Without this guard, a barely-alive
                    // network that returns null / undefined / an empty
                    // list-response would overwrite the rendered
                    // cached data — the user observed albums showing
                    // their tracklist briefly then going blank a
                    // split-second later when a partial network
                    // response landed.
                    if (fresh === null || fresh === undefined) {
                        return;
                    }
                    if (db && apply) {
                        try {
                            await apply(db, fresh);
                        } catch (err) {
                            console.warn('[cache] apply failed (bg)', queryKey, err);
                        }
                    }
                    writeSnapshot(queryKey, fresh);
                    queryClient.setQueryData(queryKey, fresh);
                } catch (err) {
                    if ((err as Error)?.name !== 'AbortError') {
                        console.info('[cache] background revalidate failed', queryKey, err);
                    }
                }
            })();
        }
        return cached;
    }

    // Cold-path hard timeout. On Capacitor WebView offline, `fetch()`
    // can hang indefinitely instead of throwing. Force a return after
    // 8s so Suspense ends and the consumer can render the snapshot or
    // an empty state.
    const COLD_NETWORK_TIMEOUT_MS = 8_000;
    let timedOut = false;
    const timeoutPromise = new Promise<TData>((resolve) => {
        setTimeout(() => {
            timedOut = true;
            resolve(null as unknown as TData);
        }, COLD_NETWORK_TIMEOUT_MS);
    });

    // Helper for the offline / failure return path. If we already have
    // a snapshot for this queryKey (placeholderData rendered it on
    // mount), return that instead of `null` — otherwise the user sees
    // the data load, then erase a split-second later when the queryFn
    // resolves with null.
    const fallbackOnFailure = (): TData => {
        const snap = readSnapshot<TData>(queryKey);
        if (snap !== undefined) {
            console.info('[cache] cold network failed; falling back to snapshot', queryKey);
            return snap;
        }
        return null as unknown as TData;
    };

    try {
        const fresh = await Promise.race([remote(ctx), timeoutPromise]);
        if (timedOut) {
            console.info('[cache] cold network timed out', queryKey);
            return fallbackOnFailure();
        }
        if (fresh === null || fresh === undefined) {
            return fallbackOnFailure();
        }
        if (db && apply) {
            try {
                await apply(db, fresh);
            } catch (err) {
                console.warn('[cache] apply failed', queryKey, err);
            }
        }
        writeSnapshot(queryKey, fresh);
        return fresh;
    } catch (err) {
        if (isLikelyNetworkError(err)) {
            console.info('[cache] cold network failed', queryKey, {
                error: (err as Error)?.message,
            });
            return fallbackOnFailure();
        }
        throw err;
    }
};

// Bug 6 — helper to merge a single page into an existing InfiniteData
// snapshot. If the page param is already present (e.g. refetch of an
// already-loaded page), we replace the entry in place instead of appending,
// preventing duplicate pages from accumulating across refetches.
export const mergePage = <TPage, TPageParam>(
    existing: InfiniteData<TPage, TPageParam> | undefined,
    pageParam: TPageParam,
    page: TPage,
): InfiniteData<TPage, TPageParam> => {
    const pages = existing?.pages ? [...existing.pages] : [];
    const pageParams = existing?.pageParams ? [...existing.pageParams] : [];
    const idx = pageParams.findIndex((p) => p === pageParam);
    if (idx >= 0) {
        pages[idx] = page;
    } else {
        pages.push(page);
        pageParams.push(pageParam);
    }
    return { pageParams, pages };
};

// useCachedQuery -----------------------------------------------------------

export interface CachedQueryArgs<TData> {
    apply?: (db: LibraryCacheDb, fresh: TData) => Promise<void>;
    enabled?: boolean;
    fromCache?: (db: LibraryCacheDb) => Promise<TData | undefined>;
    queryKey: QueryKey;
    // The existing controller call — must return a promise of the same
    // shape react-query consumers expect today.
    remote: (ctx: QueryFunctionContext) => Promise<TData>;
    staleTime?: number;
}

export const useCachedQuery = <TData>(args: CachedQueryArgs<TData>) => {
    const { apply, enabled = true, fromCache, queryKey, remote, staleTime } = args;

    return useQuery<TData>({
        enabled,
        // react-query's NonFunctionGuard<T> constraint can't be satisfied
        // by a free generic TData. The cast is safe because our query
        // data shapes are always plain objects / arrays.
        placeholderData: (() => readSnapshot<TData>(queryKey)) as never,
        queryFn: (ctx) => cachedSwr<TData>({ apply, ctx, fromCache, queryKey, remote }),
        queryKey,
        staleTime,
    });
};

// useCachedInfiniteQuery ---------------------------------------------------

export interface CachedInfiniteQueryArgs<TPage, TPageParam> {
    apply?: (db: LibraryCacheDb, page: TPage, pageParam: TPageParam) => Promise<void>;
    enabled?: boolean;
    fromCache?: (db: LibraryCacheDb, pageParam: TPageParam) => Promise<TPage | undefined>;
    getNextPageParam: (
        lastPage: TPage,
        allPages: TPage[],
        lastPageParam: TPageParam,
    ) => TPageParam | undefined;
    initialPageParam: TPageParam;
    queryKey: QueryKey;
    remote: (ctx: QueryFunctionContext<QueryKey, TPageParam>) => Promise<TPage>;
    staleTime?: number;
}

export const useCachedInfiniteQuery = <TPage, TPageParam = number>(
    args: CachedInfiniteQueryArgs<TPage, TPageParam>,
) => {
    const {
        apply,
        enabled = true,
        fromCache,
        getNextPageParam,
        initialPageParam,
        queryKey,
        remote,
        staleTime,
    } = args;

    return useInfiniteQuery<TPage, Error, InfiniteData<TPage>, QueryKey, TPageParam>({
        enabled,
        getNextPageParam,
        initialPageParam,
        placeholderData: (() => readSnapshot<InfiniteData<TPage, TPageParam>>(queryKey)) as never,
        queryFn: async (ctx) => {
            // Stale-while-revalidate per page (same shape as `cachedSwr`
            // but the per-page snapshot merge means we have to wrap the
            // logic here instead of reusing the helper).
            const db = activeDb();
            const pageParam = ctx.pageParam as TPageParam;

            let cachedPage: TPage | undefined;
            if (db && fromCache) {
                try {
                    cachedPage = await fromCache(db, pageParam);
                    if (cachedPage !== undefined) {
                        const existing = readSnapshot<InfiniteData<TPage, TPageParam>>(queryKey);
                        writeSnapshot(queryKey, mergePage(existing, pageParam, cachedPage));
                    }
                } catch (err) {
                    console.warn('[cache] fromCache failed', queryKey, err);
                }
            }

            if (cachedPage !== undefined) {
                // Background revalidate — throttled per [queryKey, pageParam]
                // so repeated navigations to the same page don't spam the
                // network within the REVALIDATE_TTL_MS window.
                const pageQueryKey = [...(queryKey as unknown[]), pageParam];
                if (shouldRevalidate(pageQueryKey)) {
                    void (async () => {
                        try {
                            const fresh = await remote(ctx);
                            if (db && apply) {
                                try {
                                    await apply(db, fresh, pageParam);
                                } catch (err) {
                                    console.warn('[cache] apply failed (bg)', queryKey, err);
                                }
                            }
                            const existing =
                                readSnapshot<InfiniteData<TPage, TPageParam>>(queryKey);
                            const next = mergePage(existing, pageParam, fresh);
                            writeSnapshot(queryKey, next);
                            queryClient.setQueryData(queryKey, next);
                        } catch (err) {
                            if ((err as Error)?.name !== 'AbortError') {
                                console.info('[cache] background revalidate failed', queryKey, err);
                            }
                        }
                    })();
                }
                return cachedPage;
            }

            const fresh = await remote(ctx);
            if (db && apply) {
                try {
                    await apply(db, fresh, pageParam);
                } catch (err) {
                    console.warn('[cache] apply failed', queryKey, err);
                }
            }
            const existing = readSnapshot<InfiniteData<TPage, TPageParam>>(queryKey);
            writeSnapshot(queryKey, mergePage(existing, pageParam, fresh));
            return fresh;
        },
        queryKey,
        staleTime,
    });
};
