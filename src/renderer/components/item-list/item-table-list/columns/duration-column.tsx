import formatDuration from 'format-duration';
import { useMemo } from 'react';

import {
    ColumnNullFallback,
    ColumnSkeletonFixed,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';

const DurationColumnBase = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: number | undefined = (rowItem as any)?.[props.columns[props.columnIndex].id];

    // Treat a 0/falsy duration as "missing", not "0:00". Servers report 0 (or
    // omit the field) when they don't know a track/playlist length, and a
    // genuine zero-length song is bogus too — so a literal "0:00" is never a
    // useful render. We show an empty cell instead (e.g. playlist rows where the
    // backend reports no aggregate duration).
    const hasDuration = typeof row === 'number' && row > 0;

    const formattedDuration = useMemo(() => {
        return hasDuration ? formatDuration(row) : null;
    }, [hasDuration, row]);

    if (hasDuration) {
        return <TableColumnTextContainer {...props}>{formattedDuration}</TableColumnTextContainer>;
    }

    if (rowItem != null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonFixed {...props} />;
};

export const DurationColumn = DurationColumnBase;
