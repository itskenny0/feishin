import {
    useMutation,
    useQuery,
    useQueryClient,
    useSuspenseQuery,
    UseSuspenseQueryOptions,
} from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { queryKeys } from '/@/renderer/api/query-keys';
import { readSnapshot, writeSnapshot } from '/@/renderer/cache';
import { useListContext } from '/@/renderer/context/list-context';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { UserFavoriteEventPayload, UserRatingEventPayload } from '/@/renderer/events/events';
import { getListRefreshMutationKey } from '/@/renderer/features/shared/components/list-refresh-button';
import { LibraryItem, SortKeyRandom } from '/@/shared/types/domain-types';

const getQueryKeyName = (itemType: LibraryItem): string => {
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
            return 'albums'; // fallback
    }
};

interface UseItemListPaginatedLoaderProps {
    currentPage: number;
    eventKey?: string;
    itemsPerPage: number;
    itemType: LibraryItem;
    listCountQuery: UseSuspenseQueryOptions<number, Error, number, readonly unknown[]>;
    listQueryFn: (args: { apiClientProps: any; query: any }) => Promise<{ items: unknown[] }>;
    // Optional cache-first page resolver (same contract as the infinite
    // loader). When provided, the cached page is returned immediately and
    // the network revalidate runs in the background.
    localFetchPage?: (args: {
        limit: number;
        query: Record<string, any>;
        startIndex: number;
    }) => Promise<undefined | { items: unknown[] }>;
    query: Record<string, any>;
    serverId: string;
}

function getInitialData(itemCount: number) {
    return Array.from({ length: itemCount }, () => undefined);
}

export const useItemListPaginatedLoader = ({
    currentPage,
    eventKey,
    itemsPerPage = 100,
    itemType,
    listCountQuery,
    listQueryFn,
    localFetchPage,
    query = {},
    serverId,
}: UseItemListPaginatedLoaderProps) => {
    const queryClient = useQueryClient();
    const { data: totalItemCount } = useSuspenseQuery<number, any, number, any>(listCountQuery);

    const { setItemCount } = useListContext();

    useEffect(() => {
        if (totalItemCount == null || !setItemCount) {
            return;
        }

        setItemCount(totalItemCount);
    }, [setItemCount, totalItemCount]);

    const pageCount = Math.ceil(totalItemCount / itemsPerPage);

    const fetchRange = getFetchRange(currentPage, itemsPerPage);
    const startIndex = fetchRange.startIndex;

    const isRandomSort = query?.sortBy === SortKeyRandom;

    const queryParams = useMemo(
        () => ({
            limit: itemsPerPage,
            startIndex: startIndex,
            ...query,
        }),
        [itemsPerPage, startIndex, query],
    );

    const queryKey = queryKeys[getQueryKeyName(itemType)].list(serverId, queryParams);

    const { data } = useQuery({
        // Upstream #2097: long stale/gc for RANDOM so a remount reuses the
        // cached response instead of fetching a fresh server shuffle.
        gcTime: isRandomSort ? 1000 * 60 * 10 : 1000 * 15,
        // Prefer a cached page from the snapshot map on first paint; fall
        // back to skeleton items only when the cache has nothing for this
        // (entity, query) pair.
        placeholderData: (() => {
            const cached = readSnapshot<{ items: unknown[] }>(queryKey);
            return cached ?? { items: getInitialData(itemsPerPage) };
        }) as never,
        queryFn: async ({ signal }) => {
            // Stale-while-revalidate. If the cache returns items we
            // RETURN them from queryFn so react-query's pending state
            // ends immediately (no spinner) and an offline session
            // doesn't break. The network call still runs in the
            // background to revalidate; failures are swallowed.
            if (localFetchPage) {
                try {
                    const cached = await localFetchPage({
                        limit: itemsPerPage,
                        query,
                        startIndex,
                    });
                    if (cached && cached.items.length > 0) {
                        writeSnapshot(queryKey, cached);
                        // RANDOM + cache hit: the local permutation is the
                        // stable one; a server revalidate would replace the
                        // page with a fresh shuffle (visible reorder).
                        if (isRandomSort) {
                            return cached;
                        }
                        void (async () => {
                            try {
                                const fresh = await listQueryFn({
                                    apiClientProps: { serverId, signal },
                                    query: queryParams,
                                });
                                writeSnapshot(queryKey, fresh);
                                queryClient.setQueryData(queryKey, fresh);
                            } catch (err) {
                                if ((err as Error)?.name !== 'AbortError') {
                                    console.info(
                                        '[cache] paginated background revalidate failed',
                                        itemType,
                                        (err as Error)?.message,
                                    );
                                }
                            }
                        })();
                        return cached;
                    }
                } catch (err) {
                    console.warn('[cache] paginated localFetchPage failed', itemType, err);
                }
            }

            const result = await listQueryFn({
                apiClientProps: { serverId, signal },
                query: queryParams,
            });

            writeSnapshot(queryKey, result);
            return result;
        },
        queryKey,
        staleTime: isRandomSort ? 1000 * 60 * 10 : 1000 * 15,
    });

    const refreshMutation = useMutation({
        mutationFn: async (force?: boolean) => {
            const queryKey = queryKeys[getQueryKeyName(itemType)].list(serverId, queryParams);

            if (force) {
                queryClient.setQueryData(queryKey, {
                    items: getInitialData(itemsPerPage),
                });
            }

            // Scope to this list's item type on this server. Previously this
            // was a global invalidateQueries() that refetched every cached
            // query in the app — favorites, sidebar playlists, home stats,
            // scrobble counts, etc. — on every refresh-button click.
            await queryClient.invalidateQueries({
                queryKey: [serverId, getQueryKeyName(itemType)],
            });
        },
        mutationKey: getListRefreshMutationKey(eventKey ?? 'paginated'),
    });

    const refreshMutationRef = useRef(refreshMutation);
    refreshMutationRef.current = refreshMutation;

    const updateItems = useCallback(
        (indexes: number[], value: object) => {
            return queryClient.setQueryData(
                queryKeys[getQueryKeyName(itemType)].list(serverId, queryParams),
                (prev: undefined | { items: unknown[] }) => {
                    if (!prev) {
                        return prev;
                    }

                    return {
                        ...prev,
                        items: prev.items.map((item: any, index) => {
                            if (!item) {
                                return item;
                            }

                            if (!indexes.includes(index)) {
                                return item;
                            }

                            return {
                                ...item,
                                ...value,
                            };
                        }),
                    };
                },
            );
        },
        [queryClient, queryParams, serverId, itemType],
    );

    useEffect(() => {
        const handleRefresh = (payload: { key: string }) => {
            if (!eventKey || eventKey !== payload.key) {
                return;
            }

            refreshMutationRef.current.mutate(true);
        };

        const handleFavorite = (payload: UserFavoriteEventPayload) => {
            if (!data || !data.items) {
                return;
            }

            if (payload.itemType !== itemType || payload.serverId !== serverId) {
                return;
            }

            // NOTE: build the index map against the UNFILTERED array so the
            // indexes line up with the array `updateItems` mutates. Filtering
            // out falsy placeholder slots here would shift every subsequent
            // index and corrupt unrelated rows.
            const idToIndexMap = data.items.reduce(
                (acc: Record<string, number>, item: any, index: number) => {
                    if (item) {
                        acc[item.id] = index;
                    }
                    return acc;
                },
                {},
            );

            const dataIndexes = payload.id
                .map((id: string) => idToIndexMap[id])
                .filter((idx) => idx !== undefined);

            if (dataIndexes.length === 0) {
                return;
            }

            return updateItems(dataIndexes, { userFavorite: payload.favorite });
        };

        const handleRating = (payload: UserRatingEventPayload) => {
            if (!data || !data.items) {
                return;
            }

            if (payload.itemType !== itemType || payload.serverId !== serverId) {
                return;
            }

            const idToIndexMap = data.items.reduce(
                (acc: Record<string, number>, item: any, index: number) => {
                    acc[item.id] = index;
                    return acc;
                },
                {},
            );

            const dataIndexes = payload.id
                .map((id: string) => idToIndexMap[id])
                .filter((idx) => idx !== undefined);

            if (dataIndexes.length === 0) {
                return;
            }

            return updateItems(dataIndexes, { userRating: payload.rating });
        };

        eventEmitter.on('ITEM_LIST_REFRESH', handleRefresh);
        eventEmitter.on('USER_FAVORITE', handleFavorite);
        eventEmitter.on('USER_RATING', handleRating);

        return () => {
            eventEmitter.off('ITEM_LIST_REFRESH', handleRefresh);
            eventEmitter.off('USER_FAVORITE', handleFavorite);
            eventEmitter.off('USER_RATING', handleRating);
        };
    }, [data, eventKey, itemType, serverId, updateItems]);

    return { data: data?.items || [], pageCount, totalItemCount };
};

const getFetchRange = (pageIndex: number, itemsPerPage: number) => {
    const startIndex = pageIndex * itemsPerPage;

    return {
        limit: itemsPerPage,
        startIndex,
    };
};
