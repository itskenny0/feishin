import clsx from 'clsx';
import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './play-queue.module.css';

import { useItemListColumnReorder } from '/@/renderer/components/item-list/helpers/use-item-list-column-reorder';
import { useItemListColumnResize } from '/@/renderer/components/item-list/helpers/use-item-list-column-resize';
import {
    ItemTableList,
    TableGroupHeader,
} from '/@/renderer/components/item-list/item-table-list/item-table-list';
import { ItemTableListColumn } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { ItemListHandle } from '/@/renderer/components/item-list/types';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { useActivePlayerSource } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useIsPlayerFetching, usePlayer } from '/@/renderer/features/player/context/player-context';
import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import { searchLibraryItems } from '/@/renderer/features/shared/utils';
import { useDragDrop } from '/@/renderer/hooks/use-drag-drop';
import { useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import {
    isShuffleEnabled,
    mapShuffledToQueueIndex,
    subscribeCurrentTrack,
    subscribePlayerQueue,
    subscribePlayerShuffle,
    useFollowCurrentSong,
    useListSettings,
    usePlayerActions,
    usePlayerSong,
    usePlayerStore,
    useQueueInPlaybackOrder,
} from '/@/renderer/store';
import { Flex } from '/@/shared/components/flex/flex';
import { LoadingOverlay } from '/@/shared/components/loading-overlay/loading-overlay';
import { useDebouncedValue } from '/@/shared/hooks/use-debounced-value';
import { useFocusWithin } from '/@/shared/hooks/use-focus-within';
import { useMergedRef } from '/@/shared/hooks/use-merged-ref';
import { Folder, LibraryItem, QueueSong, Song } from '/@/shared/types/domain-types';
import { DragTarget } from '/@/shared/types/drag-and-drop';
import { ItemListKey, Play } from '/@/shared/types/types';

type QueueProps = {
    enableScrollShadow?: boolean;
    listKey: ItemListKey;
    searchTerm: string | undefined;
};

export const PlayQueue = forwardRef<ItemListHandle, QueueProps>(
    ({ enableScrollShadow = true, listKey, searchTerm }, ref) => {
        const { table } = useListSettings(listKey) || {};

        const isFetching = useIsPlayerFetching();
        const tableRef = useRef<ItemListHandle>(null);
        const mergedRef = useMergedRef(ref, tableRef);
        const { getVisibleQueue } = usePlayerActions();
        const followCurrentSong = useFollowCurrentSong();
        const queueInPlaybackOrder = useQueueInPlaybackOrder();
        const source = useActivePlayerSource();
        const isRemote = source.mode === 'remote';

        const [debouncedSearchTerm] = useDebouncedValue(searchTerm, 200);

        const [data, setData] = useState<QueueSong[]>([]);
        const [groups, setGroups] = useState<TableGroupHeader[]>([]);

        // Remote mode: derive a QueueSong[] view from the mirrored Song[].
        // The mirror exposes Song[] (no _uniqueId); the table key is _uniqueId,
        // so we synthesize a stable id-based key. Position suffix disambiguates
        // duplicate tracks within the remote queue.
        const remoteData: QueueSong[] = useMemo(() => {
            if (!isRemote || !source.queue) return [];
            return source.queue.map((song, idx) => ({
                ...(song as Song),
                _uniqueId: `remote:${song.id}:${idx}`,
            })) as QueueSong[];
        }, [isRemote, source.queue]);

        useEffect(() => {
            // In remote mode the queue comes from the mirror (see remoteData below);
            // skip the local-store subscriptions entirely so we don't fight the mirror.
            if (isRemote) {
                return;
            }

            const setQueue = () => {
                const queue = getVisibleQueue() || { groups: [], items: [] };

                setData(queue.items);

                setGroups([]);
            };

            // Resolves the index of the currently-playing song within the visible
            // queue. Works regardless of whether the visible queue is in default
            // or shuffled order.
            const getVisibleCurrentIndex = (): number => {
                const state = usePlayerStore.getState();
                const visible = state.getVisibleQueue();
                if (queueInPlaybackOrder && isShuffleEnabled(state)) {
                    // In shuffled view, player.index is already the shuffled position.
                    return state.player.index;
                }
                let index = state.player.index;
                if (isShuffleEnabled(state)) {
                    index = mapShuffledToQueueIndex(index, state.queue.shuffled);
                }
                if (index < 0 || index >= visible.items.length) return -1;
                return index;
            };

            const unsub = subscribePlayerQueue(() => {
                setQueue();
            });

            const unsubShuffle = subscribePlayerShuffle(() => {
                setQueue();
            });

            const unsubCurrentTrack = subscribeCurrentTrack(() => {
                if (!followCurrentSong) return;
                const index = getVisibleCurrentIndex();
                if (index !== -1) {
                    tableRef.current?.scrollToIndex(index, {
                        align: 'center',
                        behavior: 'auto',
                    });
                }
            });

            const handleAutoDJQueueAdded = () => {
                if (followCurrentSong) {
                    const index = getVisibleCurrentIndex();
                    if (index !== -1) {
                        // Use setTimeout to ensure the DOM has updated with the new queue items
                        setTimeout(() => {
                            tableRef.current?.scrollToIndex(index, {
                                align: 'center',
                                behavior: 'auto',
                            });
                        }, 0);
                    }
                }
            };

            eventEmitter.on('AUTODJ_QUEUE_ADDED', handleAutoDJQueueAdded);

            setQueue();

            if (followCurrentSong) {
                const index = getVisibleCurrentIndex();
                if (index !== -1) {
                    setTimeout(() => {
                        tableRef.current?.scrollToIndex(index, {
                            align: 'center',
                            behavior: 'auto',
                        });
                    }, 0);
                }
            }

            return () => {
                unsub();
                unsubShuffle();
                unsubCurrentTrack();
                eventEmitter.off('AUTODJ_QUEUE_ADDED', handleAutoDJQueueAdded);
            };
        }, [getVisibleQueue, tableRef, followCurrentSong, queueInPlaybackOrder, isRemote]);

        const visibleData = isRemote ? remoteData : data;

        const filteredData: QueueSong[] = useMemo(() => {
            if (debouncedSearchTerm) {
                const searched = searchLibraryItems(
                    visibleData,
                    debouncedSearchTerm,
                    LibraryItem.SONG,
                );
                return searched;
            }

            return visibleData;
        }, [visibleData, debouncedSearchTerm]);

        const isEmpty = filteredData.length === 0;

        const { handleColumnReordered } = useItemListColumnReorder({
            itemListKey: listKey,
        });

        const { handleColumnResized } = useItemListColumnResize({
            itemListKey: listKey,
        });

        const currentSong = usePlayerSong();

        const localCurrentSongUniqueId = currentSong?._uniqueId;
        const remoteCurrentSongUniqueId =
            isRemote && source.queueIndex >= 0
                ? remoteData[source.queueIndex]?._uniqueId
                : undefined;
        const currentSongUniqueId = isRemote ? remoteCurrentSongUniqueId : localCurrentSongUniqueId;

        const { focused, ref: containerFocusRef } = useFocusWithin();
        const player = usePlayer();

        useHotkeys([
            [
                'delete',
                () => {
                    if (focused) {
                        const selectedItems =
                            tableRef.current?.internalState.getSelected() as QueueSong[];

                        if (!selectedItems || selectedItems.length === 0) {
                            return;
                        }

                        player.clearSelected(selectedItems);
                    }
                },
            ],
        ]);

        return (
            <div className={styles.container} ref={containerFocusRef}>
                <LoadingOverlay pos="absolute" visible={isFetching} />
                <ItemTableList
                    activeRowId={currentSongUniqueId}
                    autoFitColumns={table.autoFitColumns}
                    CellComponent={ItemTableListColumn}
                    columns={table.columns}
                    data={filteredData}
                    enableAlternateRowColors={table.enableAlternateRowColors}
                    enableDrag={!isRemote}
                    enableExpansion={false}
                    enableHeader={table.enableHeader}
                    enableHorizontalBorders={table.enableHorizontalBorders}
                    enableRowHoverHighlight={table.enableRowHoverHighlight}
                    enableScrollShadow={enableScrollShadow}
                    enableSelection
                    enableSelectionDialog={false}
                    enableVerticalBorders={table.enableVerticalBorders}
                    getRowId="_uniqueId"
                    groups={groups.length > 0 ? groups : undefined}
                    initialTop={{
                        to: 0,
                        type: 'offset',
                    }}
                    itemType={LibraryItem.QUEUE_SONG}
                    onColumnReordered={handleColumnReordered}
                    onColumnResized={handleColumnResized}
                    ref={mergedRef}
                    size={table.size}
                />
                {isEmpty && <EmptyQueueDropZone />}
            </div>
        );
    },
);

const EmptyQueueDropZone = () => {
    const { t } = useTranslation();
    const playerContext = usePlayer();

    const { isDraggedOver, ref } = useDragDrop<HTMLDivElement>({
        drop: {
            canDrop: () => {
                return true;
            },
            getData: () => {
                return {
                    id: [],
                    item: [],
                    itemType: LibraryItem.QUEUE_SONG,
                    type: DragTarget.QUEUE_SONG,
                };
            },
            onDrag: () => {
                return;
            },
            onDragLeave: () => {
                return;
            },
            onDrop: (args) => {
                if (args.self.type === DragTarget.QUEUE_SONG) {
                    const sourceServerId = (
                        args.source.item?.[0] as unknown as { _serverId: string }
                    )?._serverId;

                    const sourceItemType = args.source.itemType as LibraryItem;

                    switch (args.source.type) {
                        case DragTarget.ALBUM: {
                            if (sourceServerId) {
                                playerContext.addToQueueByFetch(
                                    sourceServerId,
                                    args.source.id,
                                    sourceItemType,
                                    Play.NOW,
                                );
                            }
                            break;
                        }
                        case DragTarget.ALBUM_ARTIST: {
                            if (sourceServerId) {
                                playerContext.addToQueueByFetch(
                                    sourceServerId,
                                    args.source.id,
                                    sourceItemType,
                                    Play.NOW,
                                );
                            }
                            break;
                        }
                        case DragTarget.ARTIST: {
                            if (sourceServerId) {
                                playerContext.addToQueueByFetch(
                                    sourceServerId,
                                    args.source.id,
                                    sourceItemType,
                                    Play.NOW,
                                );
                            }
                            break;
                        }
                        case DragTarget.FOLDER: {
                            const items = args.source.item;

                            const { folders, songs } = (items || []).reduce<{
                                folders: Folder[];
                                songs: Song[];
                            }>(
                                (acc, item) => {
                                    if ((item as unknown as Song)._itemType === LibraryItem.SONG) {
                                        acc.songs.push(item as unknown as Song);
                                    } else if (
                                        (item as unknown as Folder)._itemType === LibraryItem.FOLDER
                                    ) {
                                        acc.folders.push(item as unknown as Folder);
                                    }
                                    return acc;
                                },
                                { folders: [], songs: [] },
                            );

                            const folderIds = folders.map((folder) => folder.id);

                            // Handle folders: fetch and add to queue
                            if (folderIds.length > 0) {
                                playerContext.addToQueueByFetch(
                                    sourceServerId,
                                    folderIds,
                                    LibraryItem.FOLDER,
                                    Play.NOW,
                                );
                            }

                            // Handle songs: add directly to queue
                            if (songs.length > 0) {
                                playerContext.addToQueueByData(songs, Play.NOW);
                            }

                            break;
                        }
                        case DragTarget.GENRE: {
                            if (sourceServerId) {
                                playerContext.addToQueueByFetch(
                                    sourceServerId,
                                    args.source.id,
                                    sourceItemType,
                                    Play.NOW,
                                );
                            }
                            break;
                        }
                        case DragTarget.PLAYLIST: {
                            if (sourceServerId) {
                                playerContext.addToQueueByFetch(
                                    sourceServerId,
                                    args.source.id,
                                    sourceItemType,
                                    Play.NOW,
                                );
                            }
                            break;
                        }
                        case DragTarget.QUEUE_SONG: {
                            const sourceItems = (args.source.item || []) as QueueSong[];
                            if (sourceItems.length > 0) {
                                playerContext.addToQueueByData(sourceItems, Play.NOW);
                            }
                            break;
                        }
                        case DragTarget.SONG: {
                            const sourceItems = (args.source.item || []) as Song[];
                            if (sourceItems.length > 0) {
                                playerContext.addToQueueByData(sourceItems, Play.NOW);
                            }
                            break;
                        }
                        default: {
                            break;
                        }
                    }
                }

                return;
            },
        },
        isEnabled: true,
    });

    return (
        <Flex
            align="center"
            className={clsx(styles.dropZone, {
                [styles.draggedOver]: isDraggedOver,
            })}
            direction="column"
            gap="md"
            justify="center"
            ref={ref}
            w="100%"
        >
            <EmptyState
                description={t('emptyState.queueDescription', {
                    defaultValue:
                        'Pick a song from the library and the queue will pick up from there.',
                })}
                icon="playlistAdd"
                title={t('emptyState.queueTitle', { defaultValue: 'Your queue is empty' })}
            />
        </Flex>
    );
};
