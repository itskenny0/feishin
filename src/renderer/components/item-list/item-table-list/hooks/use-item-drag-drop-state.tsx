import type { Edge } from '@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge';

import { useCallback, useMemo, useRef } from 'react';

import { getDraggedItems } from '/@/renderer/components/item-list/helpers/get-dragged-items';
import { useItemDraggingState } from '/@/renderer/components/item-list/helpers/item-list-state';
import { ItemListStateActions } from '/@/renderer/components/item-list/helpers/item-list-state';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { PlayerContext } from '/@/renderer/features/player/context/player-context';
import { useDragDrop } from '/@/renderer/hooks/use-drag-drop';
import { Folder, LibraryItem, QueueSong, Song } from '/@/shared/types/domain-types';
import { DragData, DragOperation, DragTarget, DragTargetMap } from '/@/shared/types/drag-and-drop';

interface DragDropState<TElement extends HTMLElement = HTMLDivElement> {
    dragRef: null | React.Ref<TElement>;
    isDraggedOver: 'bottom' | 'top' | null;
    isDragging: boolean;
}

interface UseItemDragDropStateProps {
    enableDrag: boolean;
    internalState: ItemListStateActions;
    isDataRow: boolean;
    item: unknown;
    itemType: LibraryItem;
    playerContext: PlayerContext;
    playlistId?: string;
}

export const useItemDragDropState = <TElement extends HTMLElement = HTMLDivElement>({
    enableDrag,
    internalState,
    isDataRow,
    item,
    itemType,
    playerContext,
    playlistId,
}: UseItemDragDropStateProps): DragDropState<TElement> => {
    const shouldEnableDrag = enableDrag && isDataRow && !!item;

    const needsDropRegistration =
        shouldEnableDrag &&
        (itemType === LibraryItem.QUEUE_SONG || itemType === LibraryItem.PLAYLIST_SONG);

    // Stable identity for the current row. Row objects can be re-created on ordinary
    // re-renders, but their id is stable — key the memoized config on the id so the
    // pragmatic-dnd registration does not churn while the row simply re-renders.
    const itemId =
        item && typeof item === 'object' && 'id' in item ? (item as { id: string }).id : undefined;

    // Mutable values read inside the drag/drop handlers. Keeping them in refs lets the
    // memoized config objects stay referentially stable (so use-drag-drop registers once
    // per element) while the handlers still observe the latest values.
    const itemRef = useRef(item);
    const internalStateRef = useRef(internalState);
    const playerContextRef = useRef(playerContext);
    const playlistIdRef = useRef(playlistId);
    itemRef.current = item;
    internalStateRef.current = internalState;
    playerContextRef.current = playerContext;
    playlistIdRef.current = playlistId;

    const getId = useCallback(() => {
        const currentItem = itemRef.current;
        if (!currentItem || !isDataRow) {
            return [];
        }

        const draggedItems = getDraggedItems(currentItem as any, internalStateRef.current);

        return draggedItems.map((draggedItem) => draggedItem.id);
    }, [isDataRow]);

    const getItem = useCallback(() => {
        const currentItem = itemRef.current;
        if (!currentItem || !isDataRow) {
            return [];
        }

        const draggedItems = getDraggedItems(currentItem as any, internalStateRef.current);

        return draggedItems;
    }, [isDataRow]);

    const onDragStart = useCallback(() => {
        const currentItem = itemRef.current;
        if (!currentItem || !isDataRow) {
            return;
        }

        const internal = internalStateRef.current;
        const draggedItems = getDraggedItems(currentItem as any, internal);
        if (internal) {
            internal.setDragging(draggedItems);
        }
    }, [isDataRow]);

    const onDrop = useCallback(() => {
        internalStateRef.current?.setDragging([]);
    }, []);

    const dragOperation = useMemo(
        () =>
            itemType === LibraryItem.QUEUE_SONG
                ? [DragOperation.REORDER, DragOperation.ADD]
                : itemType === LibraryItem.PLAYLIST_SONG
                  ? [DragOperation.REORDER, DragOperation.ADD]
                  : [DragOperation.ADD],
        [itemType],
    );

    const dragTarget = useMemo(() => DragTargetMap[itemType] || DragTarget.GENERIC, [itemType]);

    const drag = useMemo(
        () =>
            shouldEnableDrag
                ? {
                      getId,
                      getItem,
                      itemType,
                      // Tag the drag source with its playlist context so a SONG
                      // dropped onto the queue can carry the originating
                      // playlist id (consumed in the drop onDrop SONG case →
                      // addToQueueByData's contextPlaylistId arg).
                      metadata: { playlistId },
                      onDragStart,
                      onDrop,
                      operation: dragOperation,
                      target: dragTarget,
                  }
                : undefined,
        [
            shouldEnableDrag,
            getId,
            getItem,
            itemType,
            playlistId,
            onDragStart,
            onDrop,
            dragOperation,
            dragTarget,
        ],
    );

    const drop = useMemo(
        () =>
            needsDropRegistration
                ? {
                      canDrop: (args: { source: DragData }) => {
                          if (args.source.type === DragTarget.TABLE_COLUMN) {
                              return false;
                          }

                          // Allow drops for QUEUE_SONG (queue reordering)
                          if (itemType === LibraryItem.QUEUE_SONG) {
                              return true;
                          }

                          // Allow drops for PLAYLIST_SONG (playlist reordering)
                          // Only allow drops when drag is started from the reorder handle
                          if (
                              itemType === LibraryItem.PLAYLIST_SONG &&
                              args.source.itemType === LibraryItem.PLAYLIST_SONG &&
                              args.source.metadata?.fromReorderHandle === true
                          ) {
                              return true;
                          }

                          return false;
                      },
                      getData: () => {
                          const currentItem = itemRef.current as unknown as { id: string };
                          return {
                              id: [currentItem.id],
                              item: [currentItem as unknown as unknown[]],
                              itemType,
                              type: DragTargetMap[itemType] || DragTarget.GENERIC,
                          };
                      },
                      onDrag: () => {
                          return;
                      },
                      onDragLeave: () => {
                          return;
                      },
                      onDrop: (args: { edge: Edge | null; self: DragData; source: DragData }) => {
                          const playerContext = playerContextRef.current;
                          const playlistId = playlistIdRef.current;
                          const item = itemRef.current;
                          const internalState = internalStateRef.current;

                          if (args.self.type === DragTarget.QUEUE_SONG) {
                              const sourceServerId = (
                                  args.source.item?.[0] as unknown as { _serverId: string }
                              )._serverId;

                              const sourceItemType = args.source.itemType as LibraryItem;

                              const droppedOnUniqueId = (
                                  args.self.item?.[0] as unknown as { _uniqueId: string }
                              )._uniqueId;

                              switch (args.source.type) {
                                  case DragTarget.ALBUM: {
                                      playerContext.addToQueueByFetch(
                                          sourceServerId,
                                          args.source.id,
                                          sourceItemType,
                                          { edge: args.edge, uniqueId: droppedOnUniqueId },
                                      );
                                      break;
                                  }
                                  case DragTarget.ALBUM_ARTIST: {
                                      playerContext.addToQueueByFetch(
                                          sourceServerId,
                                          args.source.id,
                                          sourceItemType,
                                          { edge: args.edge, uniqueId: droppedOnUniqueId },
                                      );
                                      break;
                                  }
                                  case DragTarget.ARTIST: {
                                      playerContext.addToQueueByFetch(
                                          sourceServerId,
                                          args.source.id,
                                          sourceItemType,
                                          { edge: args.edge, uniqueId: droppedOnUniqueId },
                                      );
                                      break;
                                  }
                                  case DragTarget.FOLDER: {
                                      const items = args.source.item;

                                      const { folders, songs } = (items || []).reduce<{
                                          folders: Folder[];
                                          songs: Song[];
                                      }>(
                                          (acc, item) => {
                                              if (
                                                  (item as unknown as Song)._itemType ===
                                                  LibraryItem.SONG
                                              ) {
                                                  acc.songs.push(item as unknown as Song);
                                              } else if (
                                                  (item as unknown as Folder)._itemType ===
                                                  LibraryItem.FOLDER
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
                                              { edge: args.edge, uniqueId: droppedOnUniqueId },
                                          );
                                      }

                                      // Handle songs: add directly to queue
                                      if (songs.length > 0) {
                                          playerContext.addToQueueByData(songs, {
                                              edge: args.edge,
                                              uniqueId: droppedOnUniqueId,
                                          });
                                      }

                                      break;
                                  }
                                  case DragTarget.GENRE: {
                                      playerContext.addToQueueByFetch(
                                          sourceServerId,
                                          args.source.id,
                                          sourceItemType,
                                          { edge: args.edge, uniqueId: droppedOnUniqueId },
                                      );
                                      break;
                                  }
                                  case DragTarget.PLAYLIST: {
                                      playerContext.addToQueueByFetch(
                                          sourceServerId,
                                          args.source.id,
                                          sourceItemType,
                                          { edge: args.edge, uniqueId: droppedOnUniqueId },
                                      );
                                      break;
                                  }
                                  case DragTarget.QUEUE_SONG: {
                                      const sourceItems = (args.source.item || []) as QueueSong[];
                                      if (
                                          sourceItems.length > 0 &&
                                          args.edge &&
                                          (args.edge === 'top' || args.edge === 'bottom')
                                      ) {
                                          playerContext.moveSelectedTo(
                                              sourceItems,
                                              args.edge,
                                              droppedOnUniqueId,
                                          );
                                      }
                                      break;
                                  }
                                  case DragTarget.SONG: {
                                      const sourceItems = (args.source.item || []) as Song[];
                                      if (sourceItems.length > 0) {
                                          // Carry the originating playlist context (tagged on
                                          // the drag source's metadata) through to the queue
                                          // so playlist-context features apply to the drop.
                                          const sourcePlaylistId = args.source.metadata
                                              ?.playlistId as string | undefined;
                                          playerContext.addToQueueByData(
                                              sourceItems,
                                              { edge: args.edge, uniqueId: droppedOnUniqueId },
                                              undefined,
                                              sourcePlaylistId ?? null,
                                          );
                                      }
                                      break;
                                  }
                                  default: {
                                      break;
                                  }
                              }
                          }

                          // Handle PLAYLIST_SONG reordering
                          // Only allow drops when drag is started from the reorder handle
                          if (
                              args.self.itemType === LibraryItem.PLAYLIST_SONG &&
                              args.source.itemType === LibraryItem.PLAYLIST_SONG &&
                              args.source.metadata?.fromReorderHandle === true &&
                              playlistId
                          ) {
                              const sourceItems = (args.source.item || []) as any[];
                              const targetItem = item as any;

                              if (
                                  sourceItems.length > 0 &&
                                  args.edge &&
                                  (args.edge === 'top' || args.edge === 'bottom') &&
                                  targetItem
                              ) {
                                  // Emit event to reorder playlist songs
                                  eventEmitter.emit('PLAYLIST_REORDER', {
                                      edge: args.edge,
                                      playlistId,
                                      sourceIds: args.source.id,
                                      targetId: targetItem.id,
                                  });
                              }
                          }

                          if (internalState) {
                              internalState.setDragging([]);
                          }

                          return;
                      },
                  }
                : undefined,
        // Mutable values (item, internalState, playerContext, playlistId) are read via
        // refs inside the handlers, so only the structural inputs force re-creation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [needsDropRegistration, itemType, itemId],
    );

    const {
        isDraggedOver,
        isDragging: isDraggingLocal,
        ref: dragRef,
    } = useDragDrop<TElement>({
        drag,
        drop,
        isEnabled: shouldEnableDrag,
    });

    const itemRowId =
        item && typeof item === 'object' && 'id' in item && internalState
            ? internalState.extractRowId(item)
            : undefined;
    const isDraggingState = useItemDraggingState(
        internalState,
        itemRowId ||
            (item && typeof item === 'object' && 'id' in item ? (item as any).id : undefined),
    );
    const isDragging = internalState ? isDraggingState : isDraggingLocal;

    return {
        dragRef: shouldEnableDrag ? dragRef : null,
        isDraggedOver: isDraggedOver === 'top' || isDraggedOver === 'bottom' ? isDraggedOver : null,
        isDragging,
    };
};
