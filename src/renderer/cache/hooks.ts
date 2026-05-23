import type { InfiniteData, QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { LibraryCacheDb } from './db';

import { getActiveCacheDb } from './db';
import { readSnapshot, writeSnapshot } from './snapshot';
import { useCacheStore } from './store';

import { queryClient } from '/@/renderer/lib/react-query';

const activeDb = (): LibraryCacheDb | undefined =>
    useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;

/**
 * Snapshot-only SWR runner for queries that don't have a Dexie table to
 * fall back on (sidecar lists, etc.). Same shape as `cachedSwr` minus
 * the Dexie hooks.
 */
export const snapshotSwr = async <TData>(args: {
    ctx: QueryFunctionContext;
    queryKey: QueryKey;
    remote: (ctx: QueryFunctionContext) => Promise<TData>;
}): Promise<TData> => {
    const { ctx, queryKey, remote } = args;
    const cached = readSnapshot<TData>(queryKey);
    if (cached !== undefined) {
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
        return cached;
    }
    const fresh = await remote(ctx);
    writeSnapshot(queryKey, fresh);
    return fresh;
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
        // Background revalidate — never awaited. The user already has
        // their data, so a slow or failed network call must not block
        // the render or throw out of queryFn.
        void (async () => {
            try {
                const fresh = await remote(ctx);
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
        return cached;
    }

    const fresh = await remote(ctx);
    if (db && apply) {
        try {
            await apply(db, fresh);
        } catch (err) {
            console.warn('[cache] apply failed', queryKey, err);
        }
    }
    writeSnapshot(queryKey, fresh);
    return fresh;
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
                // Background revalidate so an offline session never throws
                // out of queryFn when the cache has the page.
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
