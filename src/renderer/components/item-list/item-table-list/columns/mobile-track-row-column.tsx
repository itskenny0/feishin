import clsx from 'clsx';
import formatDuration from 'format-duration';
import { CSSProperties, useMemo } from 'react';

import styles from './mobile-track-row-column.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { useItemDragDropState } from '/@/renderer/components/item-list/item-table-list/hooks/use-item-drag-drop-state';
import {
    ColumnSkeletonVariable,
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { useIsActiveRow } from '/@/renderer/components/item-list/item-table-list/item-table-list-context';
import { ItemListItem } from '/@/renderer/components/item-list/types';
import { JoinedArtists } from '/@/renderer/features/albums/components/joined-artists';
import { usePlayButtonBehavior } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { ExplicitIndicator } from '/@/shared/components/explicit-indicator/explicit-indicator';
import { Text } from '/@/shared/components/text/text';
import { QueueSong } from '/@/shared/types/domain-types';

/**
 * Single-column track row used on phone viewports in place of the wide
 * multi-column table. Reuses {@link TableColumnContainer} for the existing
 * row click / double-click / context-menu / long-press / selection / drag
 * wiring so playback, multi-select and the overflow menu all behave exactly
 * like the desktop table — only the visual layout differs.
 *
 * Layout: [cover thumb] [title + artist stacked, truncated] [duration] [⋮].
 */
export const MobileTrackRowColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const item = rowItem as any;
    const song = rowItem as QueueSong;
    const internalState = props.internalState;
    const playButtonBehavior = usePlayButtonBehavior();
    const isActive = useIsActiveRow(song?.id, song?._uniqueId);

    const { dragRef, isDraggedOver, isDragging } = useItemDragDropState({
        enableDrag: !!props.enableDrag,
        internalState: props.internalState,
        isDataRow: true,
        item: rowItem,
        itemType: props.itemType,
        playerContext: props.playerContext,
        playlistId: props.playlistId,
    });

    const dragProps = {
        dragRef: props.enableDrag && rowItem ? dragRef : null,
        isDraggedOver: isDraggedOver === 'top' || isDraggedOver === 'bottom' ? isDraggedOver : null,
        isDragging,
    };

    const formattedDuration = useMemo(() => {
        const duration = item?.duration;
        return typeof duration === 'number' ? formatDuration(duration) : null;
    }, [item?.duration]);

    const handlePlay = () => {
        if (!item || !props.controls?.onDoubleClick) {
            return;
        }
        const index = props.enableHeader ? props.rowIndex - 1 : props.rowIndex;
        props.controls.onDoubleClick({
            event: null,
            index,
            internalState,
            item,
            itemType: props.itemType,
            meta: {
                playType: playButtonBehavior,
                singleSongOnly: true,
            },
        });
    };

    const handleMore = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        event.preventDefault();
        if (!rowItem) {
            return;
        }
        const listItem = rowItem as ItemListItem;
        const rowId = internalState.extractRowId(listItem);
        const index = rowId ? internalState.findItemIndex(rowId) : -1;
        props.controls.onMore?.({
            event,
            index,
            internalState,
            item: listItem,
            itemType: props.itemType,
        });
    };

    if (rowItem && 'name' in item && 'artists' in item) {
        const title = (item.name as string) ?? '';
        return (
            <TableColumnContainer
                className={clsx(styles.row, { [styles.active]: isActive })}
                containerStyle={{ '--row-height': '64px' } as CSSProperties}
                {...props}
                {...dragProps}
            >
                <div className={styles.cover} onClick={handlePlay} role="button" tabIndex={-1}>
                    <ItemImage
                        containerClassName={styles.coverImage}
                        enableDebounce={true}
                        enableViewport={false}
                        explicitStatus={item?.explicitStatus}
                        id={item?.imageId}
                        itemType={item?._itemType}
                        serverId={item?._serverId}
                        src={item?.imageUrl}
                        type="table"
                    />
                </div>
                <div className={styles.text}>
                    <Text
                        className={clsx(styles.title, { [styles.active]: isActive })}
                        isNoSelect
                        overflow="hidden"
                        size="md"
                    >
                        <ExplicitIndicator explicitStatus={item?.explicitStatus} />
                        {title}
                    </Text>
                    <div className={styles.artists}>
                        <JoinedArtists
                            artistName={item.artistName ?? item.albumArtist}
                            artists={item.artists ?? item.albumArtists}
                            linkProps={{ fw: 400, isMuted: true }}
                            rootTextProps={{ fw: 400, isMuted: true, size: 'sm' }}
                        />
                    </div>
                </div>
                <div className={styles.trailing}>
                    {formattedDuration && (
                        <Text className={styles.duration} isMuted isNoSelect size="sm">
                            {formattedDuration}
                        </Text>
                    )}
                    <ActionIcon
                        aria-label="More actions"
                        icon="ellipsisVertical"
                        iconProps={{ color: 'muted', size: 'lg' }}
                        onClick={handleMore}
                        size="md"
                        variant="subtle"
                    />
                </div>
            </TableColumnContainer>
        );
    }

    if (rowItem != null) {
        return (
            <TableColumnContainer
                className={styles.row}
                containerStyle={{ '--row-height': '64px' } as CSSProperties}
                {...props}
                {...dragProps}
            >
                &nbsp;
            </TableColumnContainer>
        );
    }

    return <ColumnSkeletonVariable {...props} />;
};
