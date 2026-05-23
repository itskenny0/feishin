import { UseSuspenseQueryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { resolveAlbumPage } from '/@/renderer/cache';
import { useItemListPaginatedLoader } from '/@/renderer/components/item-list/helpers/item-list-paginated-loader';
import { useGridRows } from '/@/renderer/components/item-list/helpers/use-grid-rows';
import { useItemListScrollPersist } from '/@/renderer/components/item-list/helpers/use-item-list-scroll-persist';
import { ItemGridList } from '/@/renderer/components/item-list/item-grid-list/item-grid-list';
import { ItemListWithPagination } from '/@/renderer/components/item-list/item-list-pagination/item-list-pagination';
import { useItemListPagination } from '/@/renderer/components/item-list/item-list-pagination/use-item-list-pagination';
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

interface AlbumListPaginatedGridProps extends ItemListGridComponentProps<AlbumListQuery> {}

export const AlbumListPaginatedGrid = ({
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
}: AlbumListPaginatedGridProps) => {
    const { pageKey } = useListContext();
    const { currentPage, onChange } = useItemListPagination();

    const listCountQuery = albumQueries.listCount({
        query: { ...query, limit: itemsPerPage },
        serverId: serverId,
    }) as UseSuspenseQueryOptions<number, Error, number, readonly unknown[]>;

    const listQueryFn = api.controller.getAlbumList;

    const { data, pageCount, totalItemCount } = useItemListPaginatedLoader({
        currentPage,
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
    });

    const { handleOnScrollEnd, scrollOffset } = useItemListScrollPersist({
        enabled: saveScrollOffset,
    });

    const rows = useGridRows(LibraryItem.ALBUM, ItemListKey.ALBUM, size);
    const enableGridMultiSelect = useEnableGridMultiSelect();

    return (
        <ItemListWithPagination
            currentPage={currentPage}
            itemsPerPage={itemsPerPage}
            onChange={onChange}
            pageCount={pageCount}
            totalItemCount={totalItemCount}
        >
            <ItemGridList
                currentPage={currentPage}
                data={data || []}
                enableExpansion
                enableMultiSelect={enableGridMultiSelect}
                gap={gap}
                initialTop={{
                    to: scrollOffset ?? 0,
                    type: 'offset',
                }}
                itemsPerRow={itemsPerRow}
                itemType={LibraryItem.ALBUM}
                onScrollEnd={handleOnScrollEnd}
                rows={rows}
                size={size}
            />
        </ItemListWithPagination>
    );
};
