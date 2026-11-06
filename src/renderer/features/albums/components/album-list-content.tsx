import { lazy, Suspense, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useListContext } from '/@/renderer/context/list-context';
import { useAlbumListFilters } from '/@/renderer/features/albums/hooks/use-album-list-filters';
import { useAlbumListCountQuery } from '/@/renderer/features/albums/queries/albums-queries';
import { EmptyState, EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
import { ListFilters, ListFiltersTitle } from '/@/renderer/features/shared/components/list-filters';
import { isFilterValueSet } from '/@/renderer/features/shared/components/list-filters';
import {
    ListGridSkeleton,
    ListTableSkeleton,
} from '/@/renderer/features/shared/components/list-skeleton';
import { ListWithSidebarContainer } from '/@/renderer/features/shared/components/list-with-sidebar-container';
import { SaveAsCollectionButton } from '/@/renderer/features/shared/components/save-as-collection-button';
import { FILTER_KEYS } from '/@/renderer/features/shared/utils';
import { useIsMobileShell } from '/@/renderer/hooks/use-breakpoint';
import { ItemListSettings, useCurrentServer, useListSettings } from '/@/renderer/store';
import { ScrollArea } from '/@/shared/components/scroll-area/scroll-area';
import { Stack } from '/@/shared/components/stack/stack';
import { AlbumListQuery, LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType, ListPaginationType } from '/@/shared/types/types';

const AlbumListInfiniteGrid = lazy(() =>
    import('/@/renderer/features/albums/components/album-list-infinite-grid').then((module) => ({
        default: module.AlbumListInfiniteGrid,
    })),
);

const AlbumListPaginatedGrid = lazy(() =>
    import('/@/renderer/features/albums/components/album-list-paginated-grid').then((module) => ({
        default: module.AlbumListPaginatedGrid,
    })),
);

const AlbumListInfiniteTable = lazy(() =>
    import('/@/renderer/features/albums/components/album-list-infinite-table').then((module) => ({
        default: module.AlbumListInfiniteTable,
    })),
);

const AlbumListPaginatedTable = lazy(() =>
    import('/@/renderer/features/albums/components/album-list-paginated-table').then((module) => ({
        default: module.AlbumListPaginatedTable,
    })),
);

const AlbumListInfiniteDetail = lazy(() =>
    import('/@/renderer/features/albums/components/album-list-infinite-detail').then((module) => ({
        default: module.AlbumListInfiniteDetail,
    })),
);

const AlbumListPaginatedDetail = lazy(() =>
    import('/@/renderer/features/albums/components/album-list-paginated-detail').then((module) => ({
        default: module.AlbumListPaginatedDetail,
    })),
);

const AlbumListFilters = () => {
    return (
        <ListWithSidebarContainer.SidebarPortal>
            <Stack h="100%" style={{ minHeight: 0 }}>
                <ListFiltersTitle itemType={LibraryItem.ALBUM} />
                <ScrollArea style={{ flex: 1, minHeight: 0 }}>
                    <ListFilters itemType={LibraryItem.ALBUM} />
                </ScrollArea>
                <Stack p="sm">
                    <SaveAsCollectionButton fullWidth itemType={LibraryItem.ALBUM} />
                </Stack>
            </Stack>
        </ListWithSidebarContainer.SidebarPortal>
    );
};

export const AlbumListContent = () => {
    return (
        <>
            <AlbumListFilters />
            <AlbumListSuspenseContainer />
        </>
    );
};

const AlbumListSuspenseContainer = () => {
    const { detail, display, grid, itemsPerPage, pagination, table } = useListSettings(
        ItemListKey.ALBUM,
    );

    const { customFilters } = useListContext();

    const fallback =
        display === ListDisplayType.TABLE ? (
            <ListTableSkeleton enableHeader={table.enableHeader} size={table.size} />
        ) : (
            <ListGridSkeleton
                columns={grid.itemsPerRowEnabled ? grid.itemsPerRow : undefined}
                gap={grid.itemGap}
                rows={2}
                size={grid.size}
            />
        );

    return (
        <Suspense fallback={fallback}>
            <AlbumListView
                detail={detail}
                display={display}
                grid={grid}
                itemsPerPage={itemsPerPage}
                overrideQuery={customFilters}
                pagination={pagination}
                table={table}
            />
        </Suspense>
    );
};

export type OverrideAlbumListQuery = Omit<Partial<AlbumListQuery>, 'limit' | 'startIndex'>;

export const AlbumListView = ({
    detail,
    display,
    emptyState,
    grid,
    itemsPerPage,
    overrideQuery,
    pagination,
    table,
}: ItemListSettings & {
    detail?: ItemListSettings['detail'];
    emptyState?: EmptyStateProps;
    overrideQuery?: OverrideAlbumListQuery;
}) => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    // A Detail choice saved on a wider screen falls back to the grid on phones.
    const isMobileShell = useIsMobileShell();
    const effectiveDisplay =
        isMobileShell && display === ListDisplayType.DETAIL ? ListDisplayType.GRID : display;
    const { pageKey, setItemCount } = useListContext();

    const { query } = useAlbumListFilters(pageKey as ItemListKey);

    const mergedQuery = useMemo(() => {
        if (!overrideQuery) {
            return query;
        }

        return {
            ...query,
            ...overrideQuery,
            sortBy: overrideQuery.sortBy || query.sortBy,
            sortOrder: overrideQuery.sortOrder || query.sortOrder,
        };
    }, [query, overrideQuery]);

    const countQuery = useAlbumListCountQuery({
        query: { ...mergedQuery, limit: itemsPerPage },
        serverId: server.id,
    });

    useEffect(() => {
        if (countQuery.data !== undefined) setItemCount?.(countQuery.data);
    }, [countQuery.data, setItemCount]);

    if (countQuery.data === 0) {
        const isFiltered = Boolean(
            isFilterValueSet(query[FILTER_KEYS.ALBUM._CUSTOM]) ||
            isFilterValueSet(query[FILTER_KEYS.ALBUM.ARTIST_IDS]) ||
            query[FILTER_KEYS.ALBUM.COMPILATION] !== undefined ||
            query[FILTER_KEYS.ALBUM.FAVORITE] !== undefined ||
            isFilterValueSet(query[FILTER_KEYS.ALBUM.GENRE_ID]) ||
            query[FILTER_KEYS.ALBUM.HAS_RATING] !== undefined ||
            isFilterValueSet(query[FILTER_KEYS.ALBUM.MAX_YEAR]) ||
            isFilterValueSet(query[FILTER_KEYS.ALBUM.MIN_YEAR]) ||
            query[FILTER_KEYS.ALBUM.RECENTLY_PLAYED] !== undefined ||
            isFilterValueSet(query[FILTER_KEYS.SHARED.SEARCH_TERM]),
        );
        const fallback: EmptyStateProps = {
            description: t('emptyState.albumsDescription', {
                defaultValue: 'Albums will appear here once your library is scanned.',
            }),
            icon: 'album',
            title: t('emptyState.albumsTitle', { defaultValue: 'No albums yet' }),
        };
        // A search or filter that matches nothing is not an empty library.
        if (isFiltered) {
            return (
                <EmptyState
                    description={t('emptyState.searchDescription')}
                    icon="search"
                    title={t('emptyState.searchTitle')}
                    {...emptyState}
                />
            );
        }
        return <EmptyState {...fallback} {...emptyState} />;
    }

    switch (effectiveDisplay) {
        case ListDisplayType.GRID: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <AlbumListInfiniteGrid
                            gap={grid.itemGap}
                            itemsPerPage={itemsPerPage}
                            itemsPerRow={grid.itemsPerRowEnabled ? grid.itemsPerRow : undefined}
                            query={mergedQuery}
                            serverId={server.id}
                            size={grid.size}
                        />
                    );
                }
                case ListPaginationType.PAGINATED: {
                    return (
                        <AlbumListPaginatedGrid
                            gap={grid.itemGap}
                            itemsPerPage={itemsPerPage}
                            itemsPerRow={grid.itemsPerRowEnabled ? grid.itemsPerRow : undefined}
                            query={mergedQuery}
                            serverId={server.id}
                            size={grid.size}
                        />
                    );
                }
                default:
                    return null;
            }
        }
        case ListDisplayType.TABLE: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <AlbumListInfiniteTable
                            autoFitColumns={table.autoFitColumns}
                            columns={table.columns}
                            enableAlternateRowColors={table.enableAlternateRowColors}
                            enableHeader={table.enableHeader}
                            enableHorizontalBorders={table.enableHorizontalBorders}
                            enableRowHoverHighlight={table.enableRowHoverHighlight}
                            enableVerticalBorders={table.enableVerticalBorders}
                            itemsPerPage={itemsPerPage}
                            query={mergedQuery}
                            serverId={server.id}
                            size={table.size}
                        />
                    );
                }
                case ListPaginationType.PAGINATED: {
                    return (
                        <AlbumListPaginatedTable
                            autoFitColumns={table.autoFitColumns}
                            columns={table.columns}
                            enableAlternateRowColors={table.enableAlternateRowColors}
                            enableHeader={table.enableHeader}
                            enableHorizontalBorders={table.enableHorizontalBorders}
                            enableRowHoverHighlight={table.enableRowHoverHighlight}
                            enableVerticalBorders={table.enableVerticalBorders}
                            itemsPerPage={itemsPerPage}
                            query={mergedQuery}
                            serverId={server.id}
                            size={table.size}
                        />
                    );
                }
                default:
                    return null;
            }
        }
        case ListDisplayType.DETAIL: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <AlbumListInfiniteDetail
                            enableHeader={detail?.enableHeader}
                            itemsPerPage={itemsPerPage}
                            query={mergedQuery}
                            serverId={server.id}
                        />
                    );
                }
                case ListPaginationType.PAGINATED: {
                    return (
                        <AlbumListPaginatedDetail
                            enableHeader={detail?.enableHeader}
                            itemsPerPage={itemsPerPage}
                            query={mergedQuery}
                            serverId={server.id}
                        />
                    );
                }
                default:
                    return null;
            }
        }
    }

    return null;
};
