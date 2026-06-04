import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router';

import { queryKeys } from '/@/renderer/api/query-keys';
import { useItemListPagination } from '/@/renderer/components/item-list/item-list-pagination/use-item-list-pagination';
import { ItemListHandle } from '/@/renderer/components/item-list/types';
import { useListContext } from '/@/renderer/context/list-context';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { PlaylistDetailAlbumView } from '/@/renderer/features/playlists/components/playlist-detail-album-view';
import { usePlaylistTrackList } from '/@/renderer/features/playlists/hooks/use-playlist-track-list';
import { usePlaylistSongListSuspenseQuery } from '/@/renderer/features/playlists/queries/playlists-queries';
import { reorderPlaylistItems } from '/@/renderer/features/playlists/utils';
import { useCurrentServer, useListSettings } from '/@/renderer/store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import {
    LibraryItem,
    PlaylistSongListQuery,
    PlaylistSongListResponse,
    Song,
} from '/@/shared/types/domain-types';
import {
    ItemListKey,
    ListDisplayType,
    ListPaginationType,
    TableColumn,
} from '/@/shared/types/types';

const PlaylistDetailSongListTable = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-detail-song-list-table').then(
        (module) => ({
            default: module.PlaylistDetailSongListTable,
        }),
    ),
);

const PlaylistDetailSongListEditTable = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-detail-song-list-table').then(
        (module) => ({
            default: module.PlaylistDetailSongListEditTable,
        }),
    ),
);

const PlaylistDetailSongListGrid = lazy(() =>
    import('/@/renderer/features/playlists/components/playlist-detail-song-list-grid').then(
        (module) => ({
            default: module.PlaylistDetailSongListGrid,
        }),
    ),
);

export const PlaylistDetailSongListContent = () => {
    const { playlistId } = useParams() as { playlistId: string };
    const server = useCurrentServer();
    const queryClient = useQueryClient();

    const playlistSongsQuery = usePlaylistSongListSuspenseQuery({
        playlistId,
        serverId: server?.id,
    });

    useEffect(() => {
        const handleRefresh = async (payload: { key: string }) => {
            if (
                payload.key !== ItemListKey.PLAYLIST_SONG &&
                payload.key !== ItemListKey.PLAYLIST_ALBUM
            ) {
                return;
            }

            const queryKey = queryKeys.playlists.songList(server?.id ?? '', playlistId);

            await queryClient.invalidateQueries({ queryKey });
            await queryClient.refetchQueries({ queryKey });
        };

        eventEmitter.on('ITEM_LIST_REFRESH', handleRefresh);

        return () => {
            eventEmitter.off('ITEM_LIST_REFRESH', handleRefresh);
        };
    }, [playlistId, queryClient, server?.id]);

    return (
        <Suspense fallback={<Spinner container />}>
            <PlaylistDetailSongList data={playlistSongsQuery.data} />
        </Suspense>
    );
};

export type OverridePlaylistSongListQuery = Omit<Partial<PlaylistSongListQuery>, 'id'>;

interface PlaylistDetailSongListViewProps {
    data: PlaylistSongListResponse;
    items?: Song[];
}

export const PlaylistDetailSongListView = ({ data, items }: PlaylistDetailSongListViewProps) => {
    const server = useCurrentServer();
    const { display, itemsPerPage, pagination, table } = useListSettings(ItemListKey.PLAYLIST_SONG);
    const { currentPage, onChange: onPageChange } = useItemListPagination();
    const isPaginated = pagination === ListPaginationType.PAGINATED;

    const paginationProps = isPaginated
        ? {
              currentPage,
              itemsPerPage,
              onPageChange,
          }
        : undefined;

    switch (display) {
        case ListDisplayType.GRID: {
            return (
                <PlaylistDetailSongListGrid
                    data={data}
                    items={items}
                    serverId={server.id}
                    {...paginationProps}
                />
            );
        }
        case ListDisplayType.TABLE: {
            return (
                <PlaylistDetailSongListTable
                    autoFitColumns={table.autoFitColumns}
                    columns={table.columns}
                    data={data}
                    enableAlternateRowColors={table.enableAlternateRowColors}
                    enableHeader={table.enableHeader}
                    enableHorizontalBorders={table.enableHorizontalBorders}
                    enableRowHoverHighlight={table.enableRowHoverHighlight}
                    enableVerticalBorders={table.enableVerticalBorders}
                    items={items}
                    serverId={server.id}
                    size={table.size}
                    {...paginationProps}
                />
            );
        }
        default:
            return null;
    }
};

export const PlaylistDetailSongListEdit = ({ data }: { data: PlaylistSongListResponse }) => {
    const { playlistId } = useParams() as { playlistId: string };
    const server = useCurrentServer();
    const { display, table } = useListSettings(ItemListKey.PLAYLIST_SONG);

    const [localData, setLocalData] = useState<PlaylistSongListResponse>(data);

    const tableRef = useRef<ItemListHandle | null>(null);

    // Listen for playlist reorder events
    useEffect(() => {
        const handleReorder = (payload: {
            edge: 'bottom' | 'top' | null;
            playlistId: string;
            sourceIds: string[];
            targetId: string;
        }) => {
            // Only handle events for this playlist
            if (payload.playlistId !== playlistId) {
                return;
            }

            setLocalData((prev) => {
                if (!prev?.items || !payload.edge) {
                    return prev;
                }

                const reorderedItems = reorderPlaylistItems(
                    prev.items,
                    payload.sourceIds,
                    payload.targetId,
                    payload.edge,
                );

                return {
                    ...prev,
                    items: reorderedItems,
                };
            });
        };

        eventEmitter.on('PLAYLIST_REORDER', handleReorder);

        return () => {
            eventEmitter.off('PLAYLIST_REORDER', handleReorder);
        };
    }, [playlistId]);

    const columns = useMemo(() => {
        return [
            {
                align: 'center' as 'center' | 'end' | 'start',
                id: TableColumn.PLAYLIST_REORDER,
                isEnabled: true,
                pinned: 'left' as 'left' | 'right' | null,
                width: 100,
            },
            ...table.columns,
        ];
    }, [table.columns]);

    const { setListData } = useListContext();

    useEffect(() => {
        setListData?.(localData.items);
    }, [localData, setListData]);

    switch (display) {
        case ListDisplayType.GRID:
        case ListDisplayType.TABLE: {
            return (
                <PlaylistDetailSongListEditTable
                    autoFitColumns={table.autoFitColumns}
                    columns={columns}
                    data={localData}
                    enableAlternateRowColors={table.enableAlternateRowColors}
                    enableHeader={table.enableHeader}
                    enableHorizontalBorders={table.enableHorizontalBorders}
                    enableRowHoverHighlight={table.enableRowHoverHighlight}
                    enableVerticalBorders={table.enableVerticalBorders}
                    ref={tableRef}
                    serverId={server.id}
                    size={table.size}
                />
            );
        }
        default:
            return null;
    }
};

const PlaylistDetailTrackView = ({ data }: { data: PlaylistSongListResponse }) => {
    const { isSmartPlaylist, mode } = useListContext();

    if (isSmartPlaylist) {
        return <PlaylistDetailTrackViewContent data={data} />;
    }

    if (mode === 'edit') {
        return <PlaylistDetailSongListEdit data={data} />;
    }

    return <PlaylistDetailTrackViewContent data={data} />;
};

const PlaylistDetailTrackViewContent = ({ data }: { data: PlaylistSongListResponse }) => {
    const { sortedAndFilteredSongs } = usePlaylistTrackList(data);
    return <PlaylistDetailSongListView data={data} items={sortedAndFilteredSongs} />;
};

const PlaylistDetailSongList = ({ data }: { data: PlaylistSongListResponse }) => {
    const { displayMode, mode } = useListContext();

    if (mode !== 'edit' && displayMode === LibraryItem.ALBUM) {
        return <PlaylistDetailAlbumView data={data} />;
    }

    return <PlaylistDetailTrackView data={data} />;
};
