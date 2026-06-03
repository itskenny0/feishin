import type { InfiniteData } from '@tanstack/react-query';

import { QueryFunctionContext, useSuspenseInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    getActiveCacheDb,
    isCacheAvailableSync,
    mergePage,
    readSnapshot,
    toCachedAlbumRow,
    writeSnapshot,
} from '/@/renderer/cache';
import { SingleFeatureCarousel } from '/@/renderer/components/feature-carousel/single-feature-carousel';
import { useCurrentServerId } from '/@/renderer/store';
import { useHomeCarouselItemsPerPage } from '/@/renderer/store/settings.store';
import { Album, AlbumListResponse, AlbumListSort, SortOrder } from '/@/shared/types/domain-types';

interface InfiniteAlbumSingleFeatureCarouselProps {
    itemLimit?: number;
    queryKey?: QueryFunctionContext['queryKey'];
}

export const AlbumInfiniteSingleFeatureCarousel = ({
    itemLimit: itemLimitProp,
    queryKey,
}: InfiniteAlbumSingleFeatureCarouselProps) => {
    const carouselItemsPerPage = useHomeCarouselItemsPerPage();
    // Explicit prop wins; otherwise fall back to the user setting (default 20).
    const itemLimit = itemLimitProp ?? carouselItemsPerPage;
    const serverId = useCurrentServerId();
    const loadMoreTriggeredRef = useRef(false);

    const defaultQueryKey = queryKeys.albums.infiniteList(serverId, {
        sortBy: AlbumListSort.RANDOM,
        sortOrder: SortOrder.DESC,
    });

    const effectiveQueryKey = queryKey || defaultQueryKey;

    const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
        useSuspenseInfiniteQuery<AlbumListResponse>({
            getNextPageParam: (lastPage, _allPages, lastPageParam) => {
                if (lastPage.items.length < itemLimit) {
                    return undefined;
                }

                const nextPageParam = Number(lastPageParam) + itemLimit;

                return String(nextPageParam);
            },
            initialData: (() =>
                readSnapshot<InfiniteData<AlbumListResponse, string>>(effectiveQueryKey)) as never,
            initialDataUpdatedAt: 0,
            initialPageParam: '0',
            queryFn: async ({ pageParam, signal }) => {
                const startIndex = Number(pageParam);
                // Suspense-safe network call: on offline failure return the
                // previously-cached page (or an empty page) instead of
                // throwing out of the queryFn so Suspense never gets stuck.
                let fresh: AlbumListResponse;
                try {
                    fresh = await api.controller.getAlbumList({
                        apiClientProps: { serverId, signal },
                        query: {
                            limit: itemLimit,
                            sortBy: AlbumListSort.RANDOM,
                            sortOrder: SortOrder.DESC,
                            startIndex,
                        },
                    });
                } catch (err) {
                    if ((err as Error)?.name === 'AbortError') throw err;
                    console.info(
                        '[cache] album-infinite-single carousel cold network failed; using snapshot',
                        effectiveQueryKey,
                        { error: (err as Error)?.message },
                    );
                    const existing =
                        readSnapshot<InfiniteData<AlbumListResponse, string>>(effectiveQueryKey);
                    const cachedPage = existing?.pages?.find(
                        (_p, i) => existing.pageParams?.[i] === String(startIndex),
                    );
                    return cachedPage ?? { items: [], startIndex, totalRecordCount: 0 };
                }
                if (isCacheAvailableSync()) {
                    try {
                        const db = getActiveCacheDb();
                        const items = fresh?.items ?? [];
                        if (db && items.length > 0) {
                            await db.albums.bulkPut(items.map(toCachedAlbumRow));
                        }
                    } catch {
                        /* swallow */
                    }
                }
                const existing =
                    readSnapshot<InfiniteData<AlbumListResponse, string>>(effectiveQueryKey);
                writeSnapshot(effectiveQueryKey, mergePage(existing, String(startIndex), fresh));
                return fresh;
            },
            queryKey: effectiveQueryKey,
        });

    // Flatten all pages and filter for albums with images
    const albumsWithImages = useMemo(() => {
        const allAlbums = data.pages.flatMap((page: AlbumListResponse) => page.items);
        // Filter for albums with images and remove duplicates by ID
        const uniqueAlbums = new Map<string, Album>();
        for (const album of allAlbums) {
            if (album.imageId && !uniqueAlbums.has(album.id)) {
                uniqueAlbums.set(album.id, album);
            }
        }
        return Array.from(uniqueAlbums.values());
    }, [data.pages]);

    const handleNearEnd = () => {
        if (hasNextPage && !isFetchingNextPage && !loadMoreTriggeredRef.current) {
            loadMoreTriggeredRef.current = true;
            fetchNextPage().finally(() => {
                loadMoreTriggeredRef.current = false;
            });
        }
    };

    useEffect(() => {
        if (
            albumsWithImages.length < itemLimit * 2 &&
            hasNextPage &&
            !isFetchingNextPage &&
            !loadMoreTriggeredRef.current
        ) {
            loadMoreTriggeredRef.current = true;
            fetchNextPage().finally(() => {
                loadMoreTriggeredRef.current = false;
            });
        }
    }, [albumsWithImages.length, hasNextPage, isFetchingNextPage, fetchNextPage, itemLimit]);

    if (albumsWithImages.length === 0) {
        return null;
    }

    return <SingleFeatureCarousel data={albumsWithImages} onNearEnd={handleNearEnd} />;
};
