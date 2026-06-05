import { useEffect, useRef, useState } from 'react';

import {
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { ItemListItem } from '/@/renderer/components/item-list/types';
import { Rating } from '/@/shared/components/rating/rating';

export const RatingColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: null | number | undefined = rowItem?.[props.columns[props.columnIndex].id];

    // Scope the inflight/read-only state to THIS cell only. Previously every
    // rating cell subscribed to the global `useIsMutating`, so a single rating
    // change re-rendered every visible rating cell. The mutation key is shared
    // (no item id), so we gate locally on the clicked control instead.
    const [isPending, setIsPending] = useState(false);
    const pendingTimeoutRef = useRef<null | ReturnType<typeof setTimeout>>(null);

    useEffect(() => {
        return () => {
            if (pendingTimeoutRef.current) {
                clearTimeout(pendingTimeoutRef.current);
            }
        };
    }, []);

    // The optimistic update flips `row` synchronously; clear pending whenever
    // the underlying value changes.
    useEffect(() => {
        setIsPending(false);
        if (pendingTimeoutRef.current) {
            clearTimeout(pendingTimeoutRef.current);
            pendingTimeoutRef.current = null;
        }
    }, [row]);

    if (typeof row === 'number' || row === null) {
        return (
            <TableColumnContainer {...props}>
                <Rating
                    className={row ? undefined : 'hover-only-flex'}
                    onChange={(rating) => {
                        setIsPending(true);
                        if (pendingTimeoutRef.current) {
                            clearTimeout(pendingTimeoutRef.current);
                        }
                        // Safety net: re-enable even if the value never changes.
                        pendingTimeoutRef.current = setTimeout(() => setIsPending(false), 3000);
                        const item = rowItem as ItemListItem;
                        const rowId = props.internalState.extractRowId(item);
                        const index = rowId ? props.internalState.findItemIndex(rowId) : -1;
                        props.controls.onRating?.({
                            event: null,
                            index,
                            internalState: props.internalState,
                            item,
                            itemType: props.itemType,
                            rating,
                        });
                    }}
                    readOnly={isPending}
                    size="xs"
                    value={row || 0}
                />
            </TableColumnContainer>
        );
    }

    return <TableColumnContainer {...props}>&nbsp;</TableColumnContainer>;
};
