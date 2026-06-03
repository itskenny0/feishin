import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useGenreListFilters } from '/@/renderer/features/genres/hooks/use-genre-list-filters';
import { useGenreListQuery } from '/@/renderer/features/genres/queries/genres-queries';
import { EmptyState, EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
import {
    ListGridSkeleton,
    ListTableSkeleton,
} from '/@/renderer/features/shared/components/list-skeleton';
import { ItemListSettings, useCurrentServer, useListSettings } from '/@/renderer/store';
import { GenreListQuery } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType, ListPaginationType } from '/@/shared/types/types';

const GenreListInfiniteGrid = lazy(() =>
    import('/@/renderer/features/genres/components/genre-list-infinite-grid').then((module) => ({
        default: module.GenreListInfiniteGrid,
    })),
);

const GenreListPaginatedGrid = lazy(() =>
    import('/@/renderer/features/genres/components/genre-list-paginated-grid').then((module) => ({
        default: module.GenreListPaginatedGrid,
    })),
);

const GenreListInfiniteTable = lazy(() =>
    import('/@/renderer/features/genres/components/genre-list-infinite-table').then((module) => ({
        default: module.GenreListInfiniteTable,
    })),
);

const GenreListPaginatedTable = lazy(() =>
    import('/@/renderer/features/genres/components/genre-list-paginated-table').then((module) => ({
        default: module.GenreListPaginatedTable,
    })),
);

export const GenreListContent = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.GENRE);

    const fallback =
        display === ListDisplayType.TABLE ? (
            <ListTableSkeleton enableHeader={table.enableHeader} size={table.size} />
        ) : (
            <ListGridSkeleton
                columns={grid.itemsPerRowEnabled ? grid.itemsPerRow : undefined}
                gap={grid.itemGap}
                rows={1}
                size={grid.size}
            />
        );

    return (
        <Suspense fallback={fallback}>
            <GenreListView
                display={display}
                grid={grid}
                itemsPerPage={itemsPerPage}
                pagination={pagination}
                table={table}
            />
        </Suspense>
    );
};

export const GenreListView = ({
    display,
    emptyState,
    grid,
    itemsPerPage,
    overrideQuery,
    pagination,
    table,
}: ItemListSettings & {
    emptyState?: EmptyStateProps;
    overrideQuery?: Omit<GenreListQuery, 'limit' | 'startIndex'>;
}) => {
    const { t } = useTranslation();
    const server = useCurrentServer();

    const { query } = useGenreListFilters();

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

    // Cheap count probe (limit 1) so an empty genre library renders a friendly
    // EmptyState instead of a blank canvas — mirrors the album list pattern.
    const countQuery = useGenreListQuery({
        query: { ...mergedQuery, limit: 1, startIndex: 0 } as GenreListQuery,
        serverId: server.id,
    });

    if (countQuery.data?.totalRecordCount === 0) {
        const fallback: EmptyStateProps = {
            description: t('emptyState.genresDescription', {
                defaultValue: 'Genres will appear here once your library is scanned.',
            }),
            icon: 'genre',
            title: t('emptyState.genresTitle', { defaultValue: 'No genres yet' }),
        };
        return <EmptyState {...fallback} {...emptyState} />;
    }

    switch (display) {
        case ListDisplayType.GRID: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <GenreListInfiniteGrid
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
                        <GenreListPaginatedGrid
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
                        <GenreListInfiniteTable
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
                        <GenreListPaginatedTable
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
    }

    return null;
};
