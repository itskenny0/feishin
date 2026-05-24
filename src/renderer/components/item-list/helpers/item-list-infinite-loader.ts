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
import { useListContext } from '/@/renderer/context/list-context';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { UserFavoriteEventPayload, UserRatingEventPayload } from '/@/renderer/events/events';
import { getListRefreshMutationKey } from '/@/renderer/features/shared/components/list-refresh-button';
import { LibraryItem } from '/@/shared/types/domain-types';

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

type InfiniteLoaderCacheData = {
    dataMap: Map<number, unknown>;
    idToIndexMap: Map<string, number>;
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
}

function getInitialData(): InfiniteLoaderCacheData {
    return {
        dataMap: new Map(),
        idToIndexMap: new Map(),
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
}: UseItemListInfiniteLoaderProps) => {
    const queryClient = useQueryClient();
    const lastFetchedPageRef = useRef<number>(-1);
    const currentVisibleRangeRef = useRef<null | { startIndex: number; stopIndex: number }>(null);
    const [isRefetching, setIsRefetching] = useState(false);
    const refetchPromiseRef = useRef<null | Promise<void>>(null);
    const previousDataQueryKeyRef = useRef<string>('');
    const isRefetchingRef = useRef<boolean>(false);

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

    // Push items into the loader's dataMap. Shared by the cache-prime and
    // network paths. When `markLoaded` is false (cache prime) we leave the
    // page-loaded flag unset so the network revalidation still runs and the
    // freshly-fetched items overwrite the cached ones.
    const writePageIntoDataMap = useCallback(
        (pageNumber: number, startIndex: number, items: unknown[], markLoaded: boolean) => {
            queryClient.setQueryData(dataQueryKey, (oldData: InfiniteLoaderCacheData) => {
                const base = oldData ?? getInitialData();
                const nextDataMap = new Map(base.dataMap);
                const nextIdToIndexMap = new Map(base.idToIndexMap);

                items.forEach((item, offset) => {
                    const index = startIndex + offset;
                    nextDataMap.set(index, item);
                    if (item && typeof item === 'object' && 'id' in (item as any)) {
                        const id = String((item as any).id);
                        nextIdToIndexMap.set(id, index);
                    }
                });

                return {
                    dataMap: nextDataMap,
                    idToIndexMap: nextIdToIndexMap,
                    pagesLoaded: markLoaded
                        ? { ...base.pagesLoaded, [pageNumber]: true }
                        : { ...base.pagesLoaded },
                    version: base.version + 1,
                };
            });
        },
        [queryClient, dataQueryKey],
    );

    const fetchPage = useCallback(
        async (pageNumber: number) => {
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
            let cachedItems: undefined | unknown[];
            if (localFetchPage) {
                try {
                    const cached = await localFetchPage({
                        limit: itemsPerPage,
                        query,
                        startIndex,
                    });
                    if (cached && cached.items.length > 0) {
                        cachedItems = cached.items;
                        writePageIntoDataMap(pageNumber, startIndex, cached.items, true);
                        lastFetchedPageRef.current = Math.max(
                            lastFetchedPageRef.current,
                            pageNumber,
                        );
                    }
                } catch (err) {
                    console.warn('[cache] grid localFetchPage failed', itemType, err);
                }
            }

            const networkPromise = queryClient
                .fetchQuery({
                    queryFn: async ({ signal }) => {
                        const result = await listQueryFn({
                            apiClientProps: { serverId, signal },
                            query: queryParams,
                        });

                        return result;
                    },
                    queryKey: queryKeys[getListQueryKeyName(itemType)].list(serverId, queryParams),
                })
                .then((result) => {
                    writePageIntoDataMap(pageNumber, startIndex, result.items, true);
                    lastFetchedPageRef.current = Math.max(lastFetchedPageRef.current, pageNumber);
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
            localFetchPage,
            writePageIntoDataMap,
        ],
    );

    // Reset the loaded pages and refetch current page when the query changes
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
                // Reset the loaded pages
                queryClient.setQueryData(dataQueryKey, (oldData: any) => {
                    if (!oldData) return oldData;
                    return {
                        ...oldData,
                        dataMap: new Map(),
                        idToIndexMap: new Map(),
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

            const currentData = queryClient.getQueryData<{
                dataMap: Map<number, unknown>;
                pagesLoaded: Record<string, boolean>;
            }>(dataQueryKey);

            const startPageBoundary = pageNumber * itemsPerPage;
            const endPageBoundary = (pageNumber + 1) * itemsPerPage;

            const distanceFromStartBoundary = range.startIndex - startPageBoundary;
            const distanceToEndBoundary = endPageBoundary - range.stopIndex;

            const thresholdDistance = Math.floor(itemsPerPage * fetchThreshold);

            const isCurrentPageLoaded = currentData?.pagesLoaded[pageNumber] ?? false;

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
        [itemsPerPage, fetchThreshold, queryClient, dataQueryKey, fetchPage],
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
            // Invalidate ONLY queries for this list's item type on this server.
            // Previously this was an unscoped `invalidateQueries()` which
            // marked every cached query in the app stale (favorites, sidebar
            // playlists, home stats, scrobble counts, …) on every refresh —
            // a perf footgun the refresh button shouldn't carry.
            queryClient.invalidateQueries({
                queryKey: [serverId, getListQueryKeyName(itemType)],
            });

            // Reset the infinite list data
            const currentData = queryClient.getQueryData<{
                dataMap: Map<number, unknown>;
                pagesLoaded: Record<string, boolean>;
            }>(dataQueryKey);

            if (force || currentData) {
                // Reset data to initial state and clear all loaded pages
                await queryClient.setQueryData(dataQueryKey, (oldData: any) => {
                    if (!oldData) return getInitialData();
                    return {
                        ...oldData,
                        dataMap: new Map(),
                        idToIndexMap: new Map(),
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

            // Refetch the current page
            await fetchPage(pageToFetch);

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
            queryClient.setQueryData(dataQueryKey, (prev: InfiniteLoaderCacheData) => {
                const nextDataMap = new Map(prev.dataMap);

                indexes.forEach((index) => {
                    const existing = nextDataMap.get(index);
                    if (!existing || typeof existing !== 'object') {
                        return;
                    }
                    nextDataMap.set(index, { ...(existing as any), ...(value as any) });
                });

                return {
                    ...prev,
                    dataMap: nextDataMap,
                    version: prev.version + 1,
                };
            });
        },
        [queryClient, dataQueryKey],
    );

    useEffect(() => {
        const handleRefresh = (payload: { key: string }) => {
            if (!eventKey || eventKey !== payload.key) {
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
                .map((id: string) => (data as any).idToIndexMap?.get(id))
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
                .map((id: string) => (data as any).idToIndexMap?.get(id))
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
    }, [data, eventKey, itemType, serverId, updateItems]);

    const itemCount = totalItemCount ?? 0;

    const getItem = useCallback(
        (index: number) => {
            return (data as any).dataMap?.get(index);
        },
        [data],
    );

    const getItemIndex = useCallback(
        (id: string) => {
            return (data as any).idToIndexMap?.get(id);
        },
        [data],
    );

    const loadedItems = useMemo(() => {
        const map: Map<number, unknown> | undefined = (data as any).dataMap;
        if (!map || map.size === 0) return [];
        return Array.from(map.entries())
            .sort(([a], [b]) => a - b)
            .map(([, v]) => v);
    }, [data]);

    return {
        dataVersion: (data as any).version ?? 0,
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
