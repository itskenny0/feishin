import {
    useMutation,
    useQuery,
    useQueryClient,
    useSuspenseQuery,
    UseSuspenseQueryOptions,
} from '@tanstack/react-query';
import throttle from 'lodash/throttle';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { queryKeys } from '/@/renderer/api/query-keys';
import {
    applyListPageToCache,
    entityForLibraryItem,
    preloadThumbnailUrls,
    prepareExplicitRefresh,
    shouldRevalidateFromNetwork,
} from '/@/renderer/cache';
import { bumpListDataVersion } from '/@/renderer/components/item-list/item-table-list/table-version-store';
import { useListContext } from '/@/renderer/context/list-context';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import {
    ITEM_LIST_REFRESH_ALL,
    UserFavoriteEventPayload,
    UserRatingEventPayload,
} from '/@/renderer/events/events';
import { getListRefreshMutationKey } from '/@/renderer/features/shared/components/list-refresh-button';
import { LibraryItem, SortKeyRandom } from '/@/shared/types/domain-types';

export const getListQueryKeyName = (itemType: LibraryItem): string => {
    switch (itemType) {
        case LibraryItem.ALBUM:
            return 'albums';
        case LibraryItem.ALBUM_ARTIST:
            return 'albumArtists';
        case LibraryItem.ARTIST:
            return 'artists';
        case LibraryItem.GENRE:
            return 'genres';
        case LibraryItem.PLAYLIST:
            return 'playlists';
        case LibraryItem.SONG:
            return 'songs';
        default:
            return 'albums';
    }
};

// The page-load bookkeeping kept in the React Query cache. The heavy
// per-index item map and the id→index map are NOT stored here — cloning a
// multi-thousand-entry Map on every page write / favorite toggle showed up in
// the perf audit (the persister re-walks them, and each clone is O(n)). They
// now live in component-held refs (see `dataMapRef` / `idToIndexMapRef`) that
// are mutated in place; this object only carries the cheap `pagesLoaded` flags
// plus a `version` counter that's bumped to signal a render.
type InfiniteLoaderCacheData = {
    pagesLoaded: Record<string, boolean>;
    version: number;
};

interface UseItemListInfiniteLoaderProps {
    eventKey: string;
    fetchThreshold?: number;
    itemsPerPage: number;
    itemType: LibraryItem;
    listCountQuery: UseSuspenseQueryOptions<number, Error, number, readonly unknown[]>;
    listQueryFn: (args: { apiClientProps: any; query: any }) => Promise<{ items: unknown[] }>;
    // Optional cache-first page resolver. When provided, the loader calls it
    // before kicking off the network request and paints the cached items
    // immediately while the revalidation happens in the background. Return
    // `undefined` to fall straight through to the network. See
    // `src/renderer/cache/grid-resolver.ts` for entity-typed resolvers.
    localFetchPage?: (args: {
        limit: number;
        query: Record<string, any>;
        startIndex: number;
    }) => Promise<undefined | { items: unknown[] }>;
    query: Record<string, any>;
    serverId: string;
    // The artwork surface bucket the consuming list renders ('table' for
    // table rows, 'itemCard' for grid cards). When set, every page write
    // bulk-primes the shared thumbnail-URL cache for the page's items in ONE
    // Dexie bulkGet, so the cells' covers paint synchronously on mount
    // instead of racing N independent IndexedDB gets.
    thumbnailVariant?: string;
}

function getInitialData(): InfiniteLoaderCacheData {
    return {
        pagesLoaded: {},
        version: 0,
    };
}

export const infiniteLoaderDataQueryKey = (
    serverId: string,
    itemType: LibraryItem,
    query?: Record<string, any>,
) => {
    if (query) {
        return [serverId, 'item-list-infinite-loader', itemType, query];
    }

    return [serverId, 'item-list-infinite-loader', itemType];
};

// ---------------------------------------------------------------------------
// Module-level item-map registry.
//
// The per-index item map MUST be shared by every hook instance rendering the
// same list: React mounts sibling instances during suspense retries (the
// loader suspends while its first page resolves), and a slow first-page
// fetch resolved into a DISCARDED instance's per-instance ref — its map died
// with it while `pagesLoaded` (React Query cache) said "loaded", freezing the
// first page as skeletons forever (playlists table, device 2026-06-10).
// Keying the maps here by the serialized data query key makes reads and
// writes converge on one map no matter which instance issued the fetch.
// Entries are cleared (not deleted) on query-change resets so live readers
// keep a coherent view; memory stays bounded by the libraries' list sizes.
// ---------------------------------------------------------------------------
interface SharedListMaps {
    dataMap: Map<number, unknown>;
    idToIndexMap: Map<string, number>;
}
const sharedListMaps = new Map<string, SharedListMaps>();

// Each distinct (server, itemType, query) combination gets its own entry —
// including every incremental search keystroke. Cap the registry LRU-style
// (Map insertion order; re-acquire moves a key to the back) so a long
// session of varied searches can't accumulate unbounded populated maps.
const SHARED_LIST_MAPS_CAP = 8;

const acquireSharedListMaps = (key: string): SharedListMaps => {
    let entry = sharedListMaps.get(key);
    if (entry) {
        // Refresh recency.
        sharedListMaps.delete(key);
        sharedListMaps.set(key, entry);
        return entry;
    }
    entry = { dataMap: new Map(), idToIndexMap: new Map() };
    sharedListMaps.set(key, entry);
    while (sharedListMaps.size > SHARED_LIST_MAPS_CAP) {
        const oldest = sharedListMaps.keys().next().value;
        if (oldest === undefined) break;
        sharedListMaps.delete(oldest);
    }
    return entry;
};

export const useItemListInfiniteLoader = ({
    eventKey,
    fetchThreshold = 0.5,
    itemsPerPage = 100,
    itemType,
    listCountQuery,
    listQueryFn,
    localFetchPage,
    query = {},
    serverId,
    thumbnailVariant,
}: UseItemListInfiniteLoaderProps) => {
    const queryClient = useQueryClient();
    const lastFetchedPageRef = useRef<number>(-1);
    const currentVisibleRangeRef = useRef<null | { startIndex: number; stopIndex: number }>(null);
    const [isRefetching, setIsRefetching] = useState(false);
    const refetchPromiseRef = useRef<null | Promise<void>>(null);
    const previousDataQueryKeyRef = useRef<string>('');
    const isRefetchingRef = useRef<boolean>(false);

    // The heavy per-index item map and id→index map live in a MODULE-LEVEL
    // registry shared by every hook instance of the same list (see
    // `sharedListMaps` above) and are mutated IN PLACE. Reads
    // (`getItem`/`getItemIndex`) go through ref-backed accessors whose
    // identity is rotated on each `dataVersion` bump (see their definitions
    // below) — load-bearing under the React Compiler, which otherwise caches
    // the impure read.
    const sharedMapsKey = useMemo(
        () => JSON.stringify([serverId, itemType, query]),
        [serverId, itemType, query],
    );
    const sharedMaps = acquireSharedListMaps(sharedMapsKey);
    const dataMapRef = useRef<Map<number, unknown>>(sharedMaps.dataMap);
    dataMapRef.current = sharedMaps.dataMap;
    const idToIndexMapRef = useRef<Map<string, number>>(sharedMaps.idToIndexMap);
    idToIndexMapRef.current = sharedMaps.idToIndexMap;

    // Clear the shared maps in place — every instance (and any in-flight
    // write continuation) keeps pointing at the SAME map, so a reset never
    // strands data in an orphaned instance.
    const resetDataMaps = useCallback(() => {
        dataMapRef.current.clear();
        idToIndexMapRef.current.clear();
    }, []);

    const { data: totalItemCount } = useSuspenseQuery<number, any, number, any>(listCountQuery);

    const { setItemCount } = useListContext();

    useEffect(() => {
        if (totalItemCount == null || !setItemCount) {
            return;
        }

        setItemCount(totalItemCount);
    }, [setItemCount, totalItemCount]);

    const dataQueryKey = useMemo(
        () => [serverId, 'item-list-infinite-loader', itemType, query],
        [serverId, itemType, query],
    );

    // Seed the "previous key" on the FIRST render of a remount whose shared
    // maps ALREADY hold this query's data, so the reset effect below SKIPS its
    // wipe + page-0 re-fetch. The per-index item maps persist in
    // `sharedListMaps` across hook instances (see the registry note above) —
    // the reset's stale comment ("maps die with the hook instance") predates
    // that. Without this seed, every revisit ran data → wipe → empty →
    // re-fetch → data: a visible double-draw of the whole list (within ms,
    // since the page re-reads from the cache). A genuine query CHANGE still
    // resets — its key differs from this seed, so the guard below won't match.
    if (previousDataQueryKeyRef.current === '' && dataMapRef.current.size > 0) {
        previousDataQueryKeyRef.current = JSON.stringify(dataQueryKey);
    }

    // Push items into the loader's dataMap. Shared by the cache-prime and
    // network paths. When `markLoaded` is false (cache prime) we leave the
    // page-loaded flag unset so the network revalidation still runs and the
    // freshly-fetched items overwrite the cached ones.
    const writePageIntoDataMap = useCallback(
        async (pageNumber: number, startIndex: number, items: unknown[], markLoaded: boolean) => {
            // Mutate the ref-held maps in place (no clone) …
            const dataMap = dataMapRef.current;
            const idToIndexMap = idToIndexMapRef.current;

            items.forEach((item, offset) => {
                const index = startIndex + offset;
                dataMap.set(index, item);
                if (item && typeof item === 'object' && 'id' in (item as any)) {
                    const id = String((item as any).id);
                    idToIndexMap.set(id, index);
                }
            });

            // Bulk-prime the page's covers into the shared thumbnail-URL
            // cache BEFORE the version bump schedules the render, so the
            // cells mount with their covers peekable (synchronous paint, no
            // skeleton). Previously this was fire-and-forget and the cells
            // consistently mounted ahead of the bulkGet, dropping every cell
            // onto the per-item Dexie path. The 250ms race keeps a slow
            // IndexedDB from delaying the row data itself — late covers just
            // resolve per-cell like before.
            if (thumbnailVariant) {
                const preload = preloadThumbnailUrls(
                    items.map((item) =>
                        item && typeof item === 'object' && 'imageId' in (item as any)
                            ? ((item as any).imageId as null | string | undefined)
                            : undefined,
                    ),
                    thumbnailVariant,
                );
                await Promise.race([
                    preload,
                    new Promise<void>((resolve) => setTimeout(resolve, 250)),
                ]);
            }

            // Bulletproof render signal for mounted cells (module-scope, no
            // React instance in the chain).
            bumpListDataVersion();

            // … then bump the small version/pagesLoaded blob in the query cache
            // to schedule a render.
            queryClient.setQueryData(dataQueryKey, (oldData: InfiniteLoaderCacheData) => {
                const base = oldData ?? getInitialData();
                return {
                    pagesLoaded: markLoaded
                        ? { ...base.pagesLoaded, [pageNumber]: true }
                        : { ...base.pagesLoaded },
                    version: base.version + 1,
                };
            });
        },
        [queryClient, dataQueryKey, thumbnailVariant],
    );

    // Upstream #2097: RANDOM sort must not re-fetch on remount — the server
    // reshuffles per request, so a back-navigation reshuffled the whole list.
    // The page responses get a long stale/gc window so the post-remount refill
    // (this loader holds its item maps in refs, which die with the hook
    // instance) replays the SAME server pages out of the react-query cache.
    // Upstream's skip-reset / skip-fetch guards are intentionally NOT ported:
    // here they would leave the freshly-emptied ref maps unfilled (blank rows).
    const isRandomSort = query?.sortBy === SortKeyRandom;

    const fetchPage = useCallback(
        async (pageNumber: number, options?: { forceNetwork?: boolean }) => {
            const startIndex = pageNumber * itemsPerPage;
            const queryParams = {
                limit: itemsPerPage,
                startIndex,
                ...query,
            };

            // Cache-first with stale-while-revalidate. If the cache
            // returns items we mark the page as loaded immediately and
            // fire the network call only in the background; failures
            // (offline / 500) stay silent so the user never sees a
            // spinner when the cache had the data. On a true cache miss
            // we still await the network call so the page eventually
            // populates.
            //
            // `forceNetwork` (the explicit-refresh path) skips the local
            // read entirely so the page repaints from a fresh server fetch.
            let cachedItems: undefined | unknown[];
            if (localFetchPage && !options?.forceNetwork) {
                try {
                    const cached = await localFetchPage({
                        limit: itemsPerPage,
                        query,
                        startIndex,
                    });
                    if (cached && cached.items.length > 0) {
                        cachedItems = cached.items;
                        await writePageIntoDataMap(pageNumber, startIndex, cached.items, true);
                        lastFetchedPageRef.current = Math.max(
                            lastFetchedPageRef.current,
                            pageNumber,
                        );
                    }
                } catch (err) {
                    console.warn('[cache] grid localFetchPage failed', itemType, err);
                }
            }

            // RANDOM + cache hit: do NOT overwrite the locally-served page.
            // The local permutation is stable across pages (sorted-result
            // memo); the server reshuffles per request, so the revalidate
            // would replace each page with a slice of a DIFFERENT
            // permutation — visible reshuffle + duplicates across pages.
            if (cachedItems && isRandomSort) {
                return;
            }

            // Sync-first: the cache answered and the sweep owns freshness —
            // skip the automatic background revalidate entirely (the shared
            // predicate logs the decision, sampled). An explicit refresh
            // re-opens the network window and lands here with forceNetwork.
            if (cachedItems && !shouldRevalidateFromNetwork()) {
                return;
            }

            const networkPromise = queryClient
                .fetchQuery({
                    // Upstream #2097: long stale/gc for RANDOM so a remount
                    // refills from the cached response instead of fetching a
                    // fresh server shuffle.
                    gcTime: isRandomSort ? 1000 * 60 * 10 : 1000 * 15,
                    queryFn: async ({ signal }) => {
                        const result = await listQueryFn({
                            apiClientProps: { serverId, signal },
                            query: queryParams,
                        });

                        return result;
                    },
                    queryKey: queryKeys[getListQueryKeyName(itemType)].list(serverId, queryParams),
                    staleTime: isRandomSort ? 1000 * 60 * 10 : 1000 * 15,
                })
                .then(async (result) => {
                    await writePageIntoDataMap(pageNumber, startIndex, result.items, true);
                    lastFetchedPageRef.current = Math.max(lastFetchedPageRef.current, pageNumber);
                    // Write-through: persist the fresh server page into the
                    // local cache (bulkPut + search/row-cache invalidation)
                    // so sync-first reads and the next cold start see it.
                    void applyListPageToCache(itemType, result.items);
                });

            if (cachedItems) {
                // Background revalidate. Swallow errors so an offline
                // session keeps showing the cached page instead of
                // exposing the fetch failure.
                void networkPromise.catch((err) => {
                    console.info(
                        '[cache] grid background revalidate failed',
                        itemType,
                        (err as Error)?.message,
                    );
                });
                return;
            }

            await networkPromise;
        },
        [
            itemsPerPage,
            query,
            queryClient,
            serverId,
            listQueryFn,
            itemType,
            isRandomSort,
            localFetchPage,
            writePageIntoDataMap,
        ],
    );

    // Reset the loaded pages and refetch current page when the query changes.
    // NOTE: upstream #2097 skips this reset for RANDOM when the query cache
    // still has data — NOT ported: this loader's item maps live in refs that
    // die with the hook instance, so the reset+refill must always run. The
    // remount-reshuffle is prevented instead by the long RANDOM stale/gc
    // window on the page fetches (and the sorted-result memo on cache reads).
    useEffect(() => {
        const currentDataQueryKey = JSON.stringify(dataQueryKey);

        if (previousDataQueryKeyRef.current === currentDataQueryKey || isRefetchingRef.current) {
            return;
        }

        previousDataQueryKeyRef.current = currentDataQueryKey;
        isRefetchingRef.current = true;

        // Capture the current visible range before resetting
        const visibleRange = currentVisibleRangeRef.current;

        // Determine which page to fetch based on current visible range
        let pageToFetch = 0;
        if (visibleRange) {
            pageToFetch = Math.floor(visibleRange.startIndex / itemsPerPage);
        }

        // Invalidate and refetch the count query to trigger Suspense
        const countQueryKey = listCountQuery.queryKey;

        // Set refetching state and create a promise to suspend
        setIsRefetching(true);
        const refetchPromise = (async () => {
            try {
                // Reset the loaded pages (and the ref-held item maps).
                resetDataMaps();
                queryClient.setQueryData(dataQueryKey, (oldData: any) => {
                    if (!oldData) return oldData;
                    return {
                        pagesLoaded: {},
                        version: (oldData?.version ?? 0) + 1,
                    };
                });

                lastFetchedPageRef.current = -1;
                currentVisibleRangeRef.current = null;

                // Race against a 2.5-second wall-clock timeout. When offline
                // the cold paths inside ensureQueryData / fetchPage can block
                // for up to COLD_NETWORK_TIMEOUT_MS (8 s) before resolving
                // with null. We must not hold the Suspense boundary open that
                // long — the grid renders empty then fills from cache once the
                // background calls settle.
                await Promise.race([
                    (async () => {
                        await queryClient.ensureQueryData({
                            queryKey: countQueryKey,
                        });
                        await fetchPage(pageToFetch);
                    })(),
                    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
                ]);
            } finally {
                setIsRefetching(false);
                isRefetchingRef.current = false;
                refetchPromiseRef.current = null;
            }
        })();

        refetchPromiseRef.current = refetchPromise;

        refetchPromise.catch(() => {
            setIsRefetching(false);
            isRefetchingRef.current = false;
            refetchPromiseRef.current = null;
        });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataQueryKey, queryClient, fetchPage, itemsPerPage]);

    const { data } = useQuery<InfiniteLoaderCacheData>({
        enabled: false,
        initialData: getInitialData(),
        queryFn: () => {
            return getInitialData();
        },
        queryKey: dataQueryKey,
    });

    // Suspend if refetching
    if (isRefetching && refetchPromiseRef.current) {
        throw refetchPromiseRef.current;
    }

    const onRangeChangedBase = useCallback(
        async (range: { startIndex: number; stopIndex: number }) => {
            // Track the current visible range
            currentVisibleRangeRef.current = range;

            const pageNumber = Math.floor(range.startIndex / itemsPerPage);

            const currentData = queryClient.getQueryData<InfiniteLoaderCacheData>(dataQueryKey);

            const startPageBoundary = pageNumber * itemsPerPage;
            const endPageBoundary = (pageNumber + 1) * itemsPerPage;

            const distanceFromStartBoundary = range.startIndex - startPageBoundary;
            const distanceToEndBoundary = endPageBoundary - range.stopIndex;

            const thresholdDistance = Math.floor(itemsPerPage * fetchThreshold);

            // A page only counts as loaded if its items are actually PRESENT
            // in the live map. `pagesLoaded` persists in the React Query
            // cache while the item maps live in hook refs — when an initial
            // page's slow fetch outlives the render instance that issued it
            // (suspense retry, remount), the flag said "loaded" while the
            // committed instance's map stayed empty, freezing the first rows
            // as skeletons forever (playlists table, device 2026-06-10).
            // Checking the page's first item self-heals every such mismatch.
            const isCurrentPageLoaded =
                (currentData?.pagesLoaded[pageNumber] ?? false) &&
                (pageNumber * itemsPerPage >= (totalItemCount ?? 0) ||
                    dataMapRef.current.has(pageNumber * itemsPerPage));

            // Fetch current page if not loaded
            if (!isCurrentPageLoaded) {
                await fetchPage(pageNumber);
            }

            // If current page is loaded, check if we should prefetch adjacent pages
            if (isCurrentPageLoaded) {
                if (
                    distanceFromStartBoundary <= thresholdDistance &&
                    pageNumber > 0 &&
                    !currentData?.pagesLoaded[pageNumber - 1]
                ) {
                    await fetchPage(pageNumber - 1);
                }

                if (
                    distanceToEndBoundary <= thresholdDistance &&
                    !currentData?.pagesLoaded[pageNumber + 1]
                ) {
                    await fetchPage(pageNumber + 1);
                }
            }
        },
        [itemsPerPage, fetchThreshold, queryClient, dataQueryKey, fetchPage, totalItemCount],
    );

    const onRangeChanged = useMemo(
        () =>
            throttle(onRangeChangedBase, 150, {
                leading: true,
                trailing: true,
            }),
        [onRangeChangedBase],
    );

    const refreshMutation = useMutation({
        mutationFn: async (force?: boolean) => {
            // Explicit refresh: open the sync-first network window, clear the
            // revalidate throttle, and drop the entity's sorted-LRU/row cache
            // + snapshots so the fresh server pages actually land.
            prepareExplicitRefresh(entityForLibraryItem(itemType));

            // Invalidate ONLY queries for this list's item type on this server.
            // Previously this was an unscoped `invalidateQueries()` which
            // marked every cached query in the app stale (favorites, sidebar
            // playlists, home stats, scrobble counts, …) on every refresh —
            // a perf footgun the refresh button shouldn't carry.
            queryClient.invalidateQueries({
                queryKey: [serverId, getListQueryKeyName(itemType)],
            });

            // Reset the infinite list data
            const currentData = queryClient.getQueryData<InfiniteLoaderCacheData>(dataQueryKey);

            if (force || currentData) {
                // Reset data to initial state and clear all loaded pages
                resetDataMaps();
                await queryClient.setQueryData(dataQueryKey, (oldData: any) => {
                    if (!oldData) return getInitialData();
                    return {
                        pagesLoaded: {},
                        version: (oldData?.version ?? 0) + 1,
                    };
                });
                lastFetchedPageRef.current = -1;
            }

            // Add a delay to make the refresh visually clear
            // await new Promise((resolve) => setTimeout(resolve, 150));

            // Determine which page to refetch based on current visible range
            let pageToFetch = 0;
            if (currentVisibleRangeRef.current) {
                // Calculate the page from the current visible range
                pageToFetch = Math.floor(currentVisibleRangeRef.current.startIndex / itemsPerPage);
            } else if (lastFetchedPageRef.current >= 0) {
                // Fallback to last fetched page if no visible range is tracked
                pageToFetch = lastFetchedPageRef.current;
            }

            // Refetch the current page — forced to the network so an explicit
            // refresh always reflects the server, even when sync-first would
            // otherwise serve the page from the local cache.
            await fetchPage(pageToFetch, { forceNetwork: true });

            // Trigger range changed to ensure adjacent pages are prefetched if needed
            const startIndex = pageToFetch * itemsPerPage;
            const stopIndex = Math.min((pageToFetch + 1) * itemsPerPage, totalItemCount);

            await onRangeChangedBase({
                startIndex,
                stopIndex,
            });
        },
        mutationKey: getListRefreshMutationKey(eventKey),
    });

    const refreshMutationRef = useRef(refreshMutation);
    refreshMutationRef.current = refreshMutation;

    const refresh = useCallback(
        async (force?: boolean) => refreshMutationRef.current.mutateAsync(force),
        [],
    );

    const updateItems = useCallback(
        (indexes: number[], value: object) => {
            // Per-item, in-place update. We replace ONLY the touched indexes
            // with a freshly-merged object (so the memoized card at that index
            // sees a new `data` reference and re-renders) while leaving every
            // other entry — and the Map itself — untouched. The previous code
            // cloned the entire multi-thousand-entry Map on every heart click.
            const dataMap = dataMapRef.current;
            let changed = false;

            indexes.forEach((index) => {
                const existing = dataMap.get(index);
                if (!existing || typeof existing !== 'object') {
                    return;
                }
                dataMap.set(index, { ...(existing as any), ...(value as any) });
                changed = true;
            });

            if (!changed) {
                return;
            }

            // Bump the version so the list re-renders and re-reads the touched
            // indexes via the stable `getItem` accessor.
            queryClient.setQueryData(dataQueryKey, (prev: InfiniteLoaderCacheData) => {
                const base = prev ?? getInitialData();
                return {
                    ...base,
                    version: base.version + 1,
                };
            });
        },
        [queryClient, dataQueryKey],
    );

    useEffect(() => {
        const handleRefresh = (payload: { key: string }) => {
            // The broadcast key (mobile pull-to-refresh) refreshes whichever
            // list loader is currently mounted.
            if (payload.key !== ITEM_LIST_REFRESH_ALL && (!eventKey || eventKey !== payload.key)) {
                return;
            }

            refreshMutationRef.current.mutate(true);
        };

        eventEmitter.on('ITEM_LIST_REFRESH', handleRefresh);

        return () => {
            eventEmitter.off('ITEM_LIST_REFRESH', handleRefresh);
        };
    }, [eventKey]);

    useEffect(() => {
        const handleFavorite = (payload: UserFavoriteEventPayload) => {
            if (payload.itemType !== itemType || payload.serverId !== serverId) {
                return;
            }

            const dataIndexes = payload.id
                .map((id: string) => idToIndexMapRef.current.get(id))
                .filter((idx): idx is number => typeof idx === 'number');

            if (dataIndexes.length === 0) {
                return;
            }

            return updateItems(dataIndexes, { userFavorite: payload.favorite });
        };

        const handleRating = (payload: UserRatingEventPayload) => {
            if (payload.itemType !== itemType || payload.serverId !== serverId) {
                return;
            }

            const dataIndexes = payload.id
                .map((id: string) => idToIndexMapRef.current.get(id))
                .filter((idx): idx is number => typeof idx === 'number');

            if (dataIndexes.length === 0) {
                return;
            }

            return updateItems(dataIndexes, { userRating: payload.rating });
        };

        eventEmitter.on('USER_FAVORITE', handleFavorite);
        eventEmitter.on('USER_RATING', handleRating);

        return () => {
            eventEmitter.off('USER_FAVORITE', handleFavorite);
            eventEmitter.off('USER_RATING', handleRating);
        };
        // `idToIndexMapRef` is a stable ref; the handlers read its current
        // value, so this effect no longer re-subscribes on every version bump
        // (it previously depended on `data`).
    }, [eventKey, itemType, serverId, updateItems]);

    const itemCount = totalItemCount ?? 0;

    const dataVersion = data?.version ?? 0;

    // Version-keyed accessors. They read through the refs (the backing maps
    // mutate IN PLACE), but their *function identity* is rotated whenever
    // `dataVersion` changes. This is load-bearing under the React Compiler:
    // the compiler auto-memoizes the `item = getRowItem(rowIndex)` derivation
    // inside every cell/column keyed on the accessor's identity. Because the
    // Map is mutated in place, an identity-stable accessor is INVISIBLE to the
    // compiler's dependency tracking — a cell that mounted before its page's
    // data landed would re-render on the version bump (via useSyncExternalStore)
    // yet reuse the stale memoized `item` (undefined → frozen skeleton). Tying
    // identity to `dataVersion` makes the new data a tracked dependency, so the
    // compiler recomputes `item` on every page write. The first-page playlists
    // freeze (device, 2026-06-10) was exactly this: the version-store signal
    // re-rendered the cell but the compiler short-circuited the impure read.
    // Cheap: the array snapshot below and the table's itemData already
    // recompute on `dataVersion`, and visible cells are bounded by
    // virtualization.
    const getItem = useCallback(
        (index: number) => {
            // The ref-held map is typed `unknown` for storage; callers (the
            // entity-typed `*-infinite-grid` components) expect the item union,
            // so cast on read — matching the pre-refactor
            // `(data as any).dataMap.get`.
            return dataMapRef.current.get(index) as any;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [dataVersion],
    );

    const getItemIndex = useCallback(
        (id: string) => {
            return idToIndexMapRef.current.get(id);
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [dataVersion],
    );

    // Snapshot the ref-held map into a sorted array. Recomputed only when the
    // version actually changes (a real data mutation), not on unrelated
    // re-renders.
    const loadedItems = useMemo(() => {
        const map = dataMapRef.current;
        if (!map || map.size === 0) return [];
        return Array.from(map.entries())
            .sort(([a], [b]) => a - b)
            .map(([, v]) => v);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dataVersion]);

    return {
        dataVersion,
        getItem,
        getItemIndex,
        itemCount,
        loadedItems,
        onRangeChanged,
        refresh,
        updateItems,
    };
};

export const parseListCountQuery = (query: any) => {
    return {
        ...query,
        limit: 1,
        startIndex: 0,
    };
};
