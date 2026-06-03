import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAlbumArtistListFilters } from '/@/renderer/features/artists/hooks/use-album-artist-list-filters';
import { useAlbumArtistListQuery } from '/@/renderer/features/artists/queries/artists-queries';
import { EmptyState, EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
import {
    ListGridSkeleton,
    ListTableSkeleton,
} from '/@/renderer/features/shared/components/list-skeleton';
import { ItemListSettings, useCurrentServer, useListSettings } from '/@/renderer/store';
import { AlbumArtistListQuery } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType, ListPaginationType } from '/@/shared/types/types';

const AlbumArtistListInfiniteGrid = lazy(() =>
    import('/@/renderer/features/artists/components/album-artist-list-infinite-grid').then(
        (module) => ({
            default: module.AlbumArtistListInfiniteGrid,
        }),
    ),
);

const AlbumArtistListPaginatedGrid = lazy(() =>
    import('/@/renderer/features/artists/components/album-artist-list-paginated-grid').then(
        (module) => ({
            default: module.AlbumArtistListPaginatedGrid,
        }),
    ),
);

const AlbumArtistListInfiniteTable = lazy(() =>
    import('/@/renderer/features/artists/components/album-artist-list-infinite-table').then(
        (module) => ({
            default: module.AlbumArtistListInfiniteTable,
        }),
    ),
);

const AlbumArtistListPaginatedTable = lazy(() =>
    import('/@/renderer/features/artists/components/album-artist-list-paginated-table').then(
        (module) => ({
            default: module.AlbumArtistListPaginatedTable,
        }),
    ),
);

export const AlbumArtistListContent = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(
        ItemListKey.ALBUM_ARTIST,
    );

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
            <AlbumArtistListView
                display={display}
                grid={grid}
                itemsPerPage={itemsPerPage}
                pagination={pagination}
                table={table}
            />
        </Suspense>
    );
};

export type OverrideAlbumArtistListQuery = Omit<AlbumArtistListQuery, 'limit' | 'startIndex'>;

export const AlbumArtistListView = ({
    display,
    emptyState,
    grid,
    itemsPerPage,
    overrideQuery,
    pagination,
    table,
}: ItemListSettings & {
    emptyState?: EmptyStateProps;
    overrideQuery?: OverrideAlbumArtistListQuery;
}) => {
    const { t } = useTranslation();
    const server = useCurrentServer();

    const { query } = useAlbumArtistListFilters();

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

    // Cheap count probe (limit 1) so an empty library / over-narrow filter
    // renders a friendly EmptyState instead of a blank canvas — mirrors the
    // album list pattern.
    const countQuery = useAlbumArtistListQuery({
        query: { ...mergedQuery, limit: 1, startIndex: 0 } as AlbumArtistListQuery,
        serverId: server.id,
    });

    if (countQuery.data?.totalRecordCount === 0) {
        const fallback: EmptyStateProps = {
            description: t('emptyState.albumArtistsDescription', {
                defaultValue: 'Album artists will appear here once your library is scanned.',
            }),
            icon: 'artist',
            title: t('emptyState.albumArtistsTitle', { defaultValue: 'No album artists yet' }),
        };
        return <EmptyState {...fallback} {...emptyState} />;
    }

    switch (display) {
        case ListDisplayType.GRID: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <AlbumArtistListInfiniteGrid
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
                        <AlbumArtistListPaginatedGrid
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
                        <AlbumArtistListInfiniteTable
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
                        <AlbumArtistListPaginatedTable
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
