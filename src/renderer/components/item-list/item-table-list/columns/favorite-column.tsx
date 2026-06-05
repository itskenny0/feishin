import { useEffect, useRef, useState } from 'react';

import {
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { ItemListItem } from '/@/renderer/components/item-list/types';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';

export const FavoriteColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: boolean | undefined = rowItem?.[props.columns[props.columnIndex].id];

    // Scope the inflight/disabled state to THIS cell only. Previously every
    // favorite cell subscribed to the global `useIsMutating`, so a single
    // favorite toggle re-rendered every visible favorite cell. The mutation key
    // is shared (no item id), so we gate locally on the clicked control instead.
    const [isPending, setIsPending] = useState(false);
    const pendingTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);

    useEffect(() => {
        return () => {
            if (pendingTimeoutRef.current) {
                clearTimeout(pendingTimeoutRef.current);
            }
        };
    }, []);

    // The optimistic update flips `row` synchronously; once it settles we can
    // re-enable the control. Clear pending whenever the underlying value changes.
    useEffect(() => {
        setIsPending(false);
        if (pendingTimeoutRef.current) {
            clearTimeout(pendingTimeoutRef.current);
            pendingTimeoutRef.current = null;
        }
    }, [row]);

    if (typeof row === 'boolean') {
        return (
            <TableColumnContainer {...props}>
                <ActionIcon
                    className={row ? undefined : 'hover-only'}
                    disabled={isPending}
                    icon="favorite"
                    iconProps={{
                        color: row ? 'primary' : 'muted',
                        fill: row ? 'primary' : undefined,
                        size: 'md',
                    }}
                    onClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                        setIsPending(true);
                        if (pendingTimeoutRef.current) {
                            clearTimeout(pendingTimeoutRef.current);
                        }
                        // Safety net: re-enable even if the value never changes
                        // (e.g. server error that restores the same value).
                        pendingTimeoutRef.current = setTimeout(() => setIsPending(false), 3000);
                        const item = rowItem as ItemListItem;
                        const rowId = props.internalState.extractRowId(item);
                        const index = rowId ? props.internalState.findItemIndex(rowId) : -1;
                        props.controls.onFavorite?.({
                            event,
                            favorite: !row,
                            index,
                            internalState: props.internalState,
                            item,
                            itemType: props.itemType,
                        });
                    }}
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        event.preventDefault();
                    }}
                    size="xs"
                    variant="subtle"
                />
            </TableColumnContainer>
        );
    }

    return <TableColumnContainer {...props}>&nbsp;</TableColumnContainer>;
};
