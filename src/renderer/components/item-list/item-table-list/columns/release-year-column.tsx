import { useMemo } from 'react';

import {
    ColumnNullFallback,
    ColumnSkeletonFixed,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { SEPARATOR_STRING } from '/@/shared/api/utils';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

const ReleaseYearColumnBase = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const item = rowItem as any;

    const yearDisplay = useMemo(() => {
        if (item && 'releaseYear' in item && isPlausibleReleaseYear(item.releaseYear)) {
            const releaseYear = item.releaseYear;
            const originalYear =
                'originalYear' in item && isPlausibleReleaseYear(item.originalYear)
                    ? item.originalYear
                    : null;

            if (originalYear !== null && originalYear !== releaseYear) {
                return `${originalYear}${SEPARATOR_STRING}${releaseYear}`;
            }

            if (typeof releaseYear === 'number') {
                return releaseYear;
            }
        }
        return null;
    }, [item]);

    if (yearDisplay !== null) {
        return <TableColumnTextContainer {...props}>{yearDisplay}</TableColumnTextContainer>;
    }

    // A loaded row with no usable year gets the empty fallback; only a row that
    // has not loaded yet keeps the skeleton (it used to stay a skeleton forever
    // for any non-null but unusable value).
    if (rowItem != null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonFixed {...props} />;
};

export const ReleaseYearColumn = ReleaseYearColumnBase;
