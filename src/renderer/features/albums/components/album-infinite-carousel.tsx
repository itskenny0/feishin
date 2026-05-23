import { QueryFunctionContext } from '@tanstack/react-query';
import { Suspense, useCallback, useMemo } from 'react';

import {
    GridCarousel,
    GridCarouselSkeletonFallback,
    useGridCarouselContainerQuery,
} from '/@/renderer/components/grid-carousel/grid-carousel-v2';
import { DataRow, MemoizedItemCard } from '/@/renderer/components/item-card/item-card';
import { useDefaultItemListControls } from '/@/renderer/components/item-list/helpers/item-list-controls';
import { useGridRows } from '/@/renderer/components/item-list/helpers/use-grid-rows';
import { useAlbumInfiniteListSuspenseQuery } from '/@/renderer/features/albums/queries/albums-queries';
import { useCurrentServerId } from '/@/renderer/store';
import {
    Album,
    AlbumListQuery,
    AlbumListResponse,
    AlbumListSort,
    LibraryItem,
    SortOrder,
} from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface AlbumCarouselProps {
    containerQuery?: ReturnType<typeof useGridCarouselContainerQuery>;
    enableRefresh?: boolean;
    excludeIds?: string[];
    query?: Partial<Omit<AlbumListQuery, 'startIndex'>>;
    queryKey?: QueryFunctionContext['queryKey'];
    rowCount?: number;
    sortBy: AlbumListSort;
    sortOrder: SortOrder;
    title: React.ReactNode | string;
}

const BaseAlbumInfiniteCarousel = (props: AlbumCarouselProps & { rows: DataRow[] }) => {
    const {
        containerQuery,
        enableRefresh,
        excludeIds,
        query: additionalQuery,
        queryKey,
        rowCount = 1,
        rows,
        sortBy,
        sortOrder,
        title,
    } = props;
    const {
        data: albums,
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        refetch,
    } = useAlbumListInfinite(sortBy, sortOrder, 20, additionalQuery, queryKey);

    const controls = useDefaultItemListControls();

    const cards = useMemo(() => {
        const allItems = albums?.pages.flatMap((page: AlbumListResponse) => page.items) || [];
        const filteredItems = excludeIds
            ? allItems.filter((album) => !excludeIds.includes(album.id))
            : allItems;

        return filteredItems.map((album: Album) => ({
            content: (
                <MemoizedItemCard
                    controls={controls}
                    data={album}
                    enableDrag
                    enableExpansion
                    imageFetchPriority="low"
                    itemType={LibraryItem.ALBUM}
                    rows={rows}
                    type="poster"
                    withControls
                />
            ),
            id: album.id,
        }));
    }, [albums, controls, excludeIds, rows]);

    const handleNextPage = useCallback(() => {}, []);

    const handlePrevPage = useCallback(() => {}, []);

    const handleRefresh = useCallback(() => {
        refetch();
    }, [refetch]);

    const firstPageItems = excludeIds
        ? albums?.pages[0]?.items.filter((album) => !excludeIds.includes(album.id)) || []
        : albums?.pages[0]?.items || [];

    if (firstPageItems.length === 0) {
        return null;
    }

    return (
        <GridCarousel
            cards={cards}
            containerQuery={containerQuery}
            enableRefresh={enableRefresh}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            loadNextPage={fetchNextPage}
            onNextPage={handleNextPage}
            onPrevPage={handlePrevPage}
            onRefresh={handleRefresh}
            placeholderItemType={LibraryItem.ALBUM}
            placeholderRows={rows}
            rowCount={rowCount}
            title={title}
        />
    );
};

export const AlbumInfiniteCarousel = (props: AlbumCarouselProps) => {
    const rows = useGridRows(LibraryItem.ALBUM, ItemListKey.ALBUM);

    return (
        <Suspense
            fallback={
                <GridCarouselSkeletonFallback
                    containerQuery={props.containerQuery}
                    placeholderItemType={LibraryItem.ALBUM}
                    placeholderRows={rows}
                    title={props.title}
                />
            }
        >
            <BaseAlbumInfiniteCarousel {...props} rows={rows} />
        </Suspense>
    );
};

function useAlbumListInfinite(
    sortBy: AlbumListSort,
    sortOrder: SortOrder,
    itemLimit: number,
    additionalQuery?: Partial<Omit<AlbumListQuery, 'startIndex'>>,
    overrideQueryKey?: QueryFunctionContext['queryKey'],
) {
    const serverId = useCurrentServerId();

    return useAlbumInfiniteListSuspenseQuery({
        itemLimit,
        query: {
            sortBy,
            sortOrder,
            ...additionalQuery,
        },
        queryKey: overrideQueryKey,
        serverId,
    });
}
