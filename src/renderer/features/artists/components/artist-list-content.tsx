import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useArtistListFilters } from '/@/renderer/features/artists/hooks/use-artist-list-filters';
import { useArtistListQuery } from '/@/renderer/features/artists/queries/artists-queries';
import { EmptyState, EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
import {
    ListGridSkeleton,
    ListTableSkeleton,
} from '/@/renderer/features/shared/components/list-skeleton';
import { ItemListSettings, useCurrentServer, useListSettings } from '/@/renderer/store';
import { ArtistListQuery } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType, ListPaginationType } from '/@/shared/types/types';

const ArtistListInfiniteGrid = lazy(() =>
    import('/@/renderer/features/artists/components/artist-list-infinite-grid').then((module) => ({
        default: module.ArtistListInfiniteGrid,
    })),
);

const ArtistListPaginatedGrid = lazy(() =>
    import('/@/renderer/features/artists/components/artist-list-paginated-grid').then((module) => ({
        default: module.ArtistListPaginatedGrid,
    })),
);

const ArtistListInfiniteTable = lazy(() =>
    import('/@/renderer/features/artists/components/artist-list-infinite-table').then((module) => ({
        default: module.ArtistListInfiniteTable,
    })),
);

const ArtistListPaginatedTable = lazy(() =>
    import('/@/renderer/features/artists/components/artist-list-paginated-table').then(
        (module) => ({
            default: module.ArtistListPaginatedTable,
        }),
    ),
);

export const ArtistListContent = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.ARTIST);

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
            <ArtistListView
                display={display}
                grid={grid}
                itemsPerPage={itemsPerPage}
                pagination={pagination}
                table={table}
            />
        </Suspense>
    );
};

export type OverrideArtistListQuery = Omit<ArtistListQuery, 'limit' | 'startIndex'>;

export const ArtistListView = ({
    display,
    emptyState,
    grid,
    itemsPerPage,
    overrideQuery,
    pagination,
    table,
}: ItemListSettings & {
    emptyState?: EmptyStateProps;
    overrideQuery?: OverrideArtistListQuery;
}) => {
    const { t } = useTranslation();
    const server = useCurrentServer();

    const { query } = useArtistListFilters();

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

    // Cheap count probe (limit 1) so an empty artist library renders a
    // friendly EmptyState instead of a blank canvas — mirrors the album list
    // pattern.
    const countQuery = useArtistListQuery({
        query: { ...mergedQuery, limit: 1, startIndex: 0 } as ArtistListQuery,
        serverId: server.id,
    });

    if (countQuery.data?.totalRecordCount === 0) {
        const fallback: EmptyStateProps = {
            description: t('emptyState.artistsDescription', {
                defaultValue: 'Artists will appear here once your library is scanned.',
            }),
            icon: 'artist',
            title: t('emptyState.artistsTitle', { defaultValue: 'No artists yet' }),
        };
        return <EmptyState {...fallback} {...emptyState} />;
    }

    switch (display) {
        case ListDisplayType.GRID: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <ArtistListInfiniteGrid
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
                        <ArtistListPaginatedGrid
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
                        <ArtistListInfiniteTable
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
                        <ArtistListPaginatedTable
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
