import { UseSuspenseQueryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { resolveAlbumPage } from '/@/renderer/cache';
import { useItemListInfiniteLoader } from '/@/renderer/components/item-list/helpers/item-list-infinite-loader';
import { useGridRows } from '/@/renderer/components/item-list/helpers/use-grid-rows';
import { useItemListScrollPersist } from '/@/renderer/components/item-list/helpers/use-item-list-scroll-persist';
import { ItemGridList } from '/@/renderer/components/item-list/item-grid-list/item-grid-list';
import { ItemListGridComponentProps } from '/@/renderer/components/item-list/types';
import { useListContext } from '/@/renderer/context/list-context';
import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { useEnableGridMultiSelect } from '/@/renderer/store';
import {
    AlbumListQuery,
    AlbumListSort,
    LibraryItem,
    SortOrder,
} from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface AlbumListInfiniteGridProps extends ItemListGridComponentProps<AlbumListQuery> {}

export const AlbumListInfiniteGrid = ({
    gap = 'md',
    itemsPerPage = 50,
    itemsPerRow,
    query = {
        sortBy: AlbumListSort.RECENTLY_ADDED,
        sortOrder: SortOrder.DESC,
    },
    saveScrollOffset = true,
    serverId,
    size,
}: AlbumListInfiniteGridProps) => {
    const listCountQuery = albumQueries.listCount({
        query: { ...query, limit: itemsPerPage },
        serverId: serverId,
    }) as UseSuspenseQueryOptions<number, Error, number, readonly unknown[]>;

    const listQueryFn = api.controller.getAlbumList;

    const { pageKey } = useListContext();

    const { dataVersion, getItem, getItemIndex, itemCount, loadedItems, onRangeChanged } =
        useItemListInfiniteLoader({
            eventKey: pageKey || ItemListKey.ALBUM,
            itemsPerPage,
            itemType: LibraryItem.ALBUM,
            listCountQuery,
            listQueryFn,
            localFetchPage: (args) =>
                resolveAlbumPage({
                    limit: args.limit,
                    query: args.query as AlbumListQuery,
                    startIndex: args.startIndex,
                }),
            query,
            serverId,
            thumbnailVariant: 'itemCard',
        });

    const { handleOnScrollEnd, scrollOffset } = useItemListScrollPersist({
        enabled: saveScrollOffset,
    });

    const rows = useGridRows(LibraryItem.ALBUM, ItemListKey.ALBUM, size);
    const enableGridMultiSelect = useEnableGridMultiSelect();

    return (
        <ItemGridList
            data={loadedItems}
            dataVersion={dataVersion}
            enableExpansion
            enableMultiSelect={enableGridMultiSelect}
            gap={gap}
            getItem={getItem}
            getItemIndex={getItemIndex}
            initialTop={{
                to: scrollOffset ?? 0,
                type: 'offset',
            }}
            itemCount={itemCount}
            itemsPerRow={itemsPerRow}
            itemType={LibraryItem.ALBUM}
            onRangeChanged={onRangeChanged}
            onScrollEnd={handleOnScrollEnd}
            rows={rows}
            size={size}
        />
    );
};
