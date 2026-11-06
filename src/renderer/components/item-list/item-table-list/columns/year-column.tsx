import { useMemo } from 'react';

import {
    ColumnNullFallback,
    ColumnSkeletonFixed,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

const YearColumnBase = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const item = rowItem as any;

    const yearDisplay = useMemo(() => {
        // Gate through the plausibility check so cached rows that still carry
        // a placeholder year (e.g. 1 from an unknown Jellyfin date) show the
        // empty fallback instead of "1".
        if (item && 'year' in item && isPlausibleReleaseYear(item.year)) {
            return item.year;
        }
        return null;
    }, [item]);

    if (yearDisplay !== null) {
        return <TableColumnTextContainer {...props}>{yearDisplay}</TableColumnTextContainer>;
    }

    if (rowItem != null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonFixed {...props} />;
};

export const YearColumn = YearColumnBase;
