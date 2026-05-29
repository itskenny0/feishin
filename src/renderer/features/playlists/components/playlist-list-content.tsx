import { lazy, Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { openCreatePlaylistModal } from './create-playlist-form';

import { usePlaylistListFilters } from '/@/renderer/features/playlists/hooks/use-playlist-list-filters';
import { usePlaylistListQuery } from '/@/renderer/features/playlists/queries/playlists-queries';
import { EmptyState, EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
import { ItemListSettings, useCurrentServer, useListSettings } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { PlaylistListQuery } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType, ListPaginationType } from '/@/shared/types/types';

const PlaylistListInfiniteGrid = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-list-infinite-grid').then(
        (module) => ({
            default: module.PlaylistListInfiniteGrid,
        }),
    ),
);

const PlaylistListPaginatedGrid = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-list-paginated-grid').then(
        (module) => ({
            default: module.PlaylistListPaginatedGrid,
        }),
    ),
);

const PlaylistListInfiniteTable = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-list-infinite-table').then(
        (module) => ({
            default: module.PlaylistListInfiniteTable,
        }),
    ),
);

const PlaylistListPaginatedTable = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-list-paginated-table').then(
        (module) => ({
            default: module.PlaylistListPaginatedTable,
        }),
    ),
);

export const PlaylistListContent = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(
        ItemListKey.PLAYLIST,
    );

    return (
        <Suspense fallback={<Spinner container />}>
            <PlaylistListView
                display={display}
                grid={grid}
                itemsPerPage={itemsPerPage}
                pagination={pagination}
                table={table}
            />
        </Suspense>
    );
};

export const PlaylistListView = ({
    display,
    emptyState,
    grid,
    itemsPerPage,
    overrideQuery,
    pagination,
    table,
}: ItemListSettings & {
    emptyState?: EmptyStateProps;
    overrideQuery?: Omit<PlaylistListQuery, 'limit' | 'startIndex'>;
}) => {
    const { t } = useTranslation();
    const server = useCurrentServer();

    const { query } = usePlaylistListFilters();

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

    // Cheap count probe (limit 1) so an empty playlist library renders a
    // friendly EmptyState with a "Create playlist" CTA instead of a blank
    // canvas — mirrors the album list pattern.
    const countQuery = usePlaylistListQuery({
        query: { ...mergedQuery, limit: 1, startIndex: 0 } as PlaylistListQuery,
        serverId: server.id,
    });

    if (countQuery.data?.totalRecordCount === 0) {
        const fallback: EmptyStateProps = {
            action: (
                <Button onClick={() => openCreatePlaylistModal(server)} variant="filled">
                    {t('emptyState.createPlaylist', { defaultValue: 'Create playlist' })}
                </Button>
            ),
            description: t('emptyState.playlistsDescription', {
                defaultValue: 'Create a playlist to start organizing your music.',
            }),
            icon: 'playlist',
            title: t('emptyState.playlistsTitle', { defaultValue: 'No playlists yet' }),
        };
        return <EmptyState {...fallback} {...emptyState} />;
    }

    switch (display) {
        case ListDisplayType.GRID: {
            switch (pagination) {
                case ListPaginationType.INFINITE: {
                    return (
                        <PlaylistListInfiniteGrid
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
                        <PlaylistListPaginatedGrid
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
                        <PlaylistListInfiniteTable
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
                        <PlaylistListPaginatedTable
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
