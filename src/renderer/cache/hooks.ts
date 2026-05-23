import type { InfiniteData, QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';

import type { LibraryCacheDb } from './db';

import { getActiveCacheDb } from './db';
import { readSnapshot, writeSnapshot } from './snapshot';
import { useCacheStore } from './store';

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
        queryFn: async (ctx) => {
            // Bug 7 — gate on the cache store rather than the module-level
            // sync probe. The store's `cacheAvailable` flag is set by the
            // lifecycle hook AFTER the async probe resolves AND honours the
            // user's opt-in choice; the sync probe alone races mounts that
            // run before the lifecycle effect has finished.
            const db =
                useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;

            // Cache-first read warms the snapshot map for the next mount,
            // even if the network call later fails.
            if (db && fromCache) {
                try {
                    const cached = await fromCache(db);
                    if (cached !== undefined) writeSnapshot(queryKey, cached);
                } catch (err) {
                    // Cache reads must never break the query. Console only.
                    console.warn('[cache] fromCache failed', queryKey, err);
                }
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
        },
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
            // Bug 7 — see useCachedQuery above; same rationale.
            const db =
                useCacheStore.getState().cacheAvailable === true ? getActiveCacheDb() : undefined;
            const pageParam = ctx.pageParam as TPageParam;

            // Cache read for THIS page. We merge it into the existing
            // InfiniteData snapshot so placeholderData on the next mount
            // sees a primed cache that includes every page we've read
            // since launch. Bug 6 — `mergePage` replaces in place when
            // the page param is already in the snapshot, instead of
            // appending a duplicate.
            if (db && fromCache) {
                try {
                    const cachedPage = await fromCache(db, pageParam);
                    if (cachedPage !== undefined) {
                        const existing = readSnapshot<InfiniteData<TPage, TPageParam>>(queryKey);
                        writeSnapshot(queryKey, mergePage(existing, pageParam, cachedPage));
                    }
                } catch (err) {
                    console.warn('[cache] fromCache failed', queryKey, err);
                }
            }

            const fresh = await remote(ctx);

            if (db && apply) {
                try {
                    await apply(db, fresh, pageParam);
                } catch (err) {
                    console.warn('[cache] apply failed', queryKey, err);
                }
            }

            // Bug 6 — same merge helper for the post-remote update so a
            // refetch of the same pageParam doesn't grow the snapshot.
            const existing = readSnapshot<InfiniteData<TPage, TPageParam>>(queryKey);
            writeSnapshot(queryKey, mergePage(existing, pageParam, fresh));
            return fresh;
        },
        queryKey,
        staleTime,
    });
};
