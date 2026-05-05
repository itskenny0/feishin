import {
    ColumnNullFallback,
    ColumnSkeletonFixed,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';

export const NumericColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const row: number | undefined = (rowItem as any)?.[props.columns[props.columnIndex].id];

    if (typeof row === 'number') {
        return <TableColumnTextContainer {...props}>{row}</TableColumnTextContainer>;
    }

    // No skeleton when the row is loaded but the field is genuinely missing
    // (e.g. Jellyfin omits IndexNumber/ParentIndexNumber for songs without
    // track tags). Skeleton only when the row itself hasn't loaded yet.
    if (rowItem != null) {
        return <ColumnNullFallback {...props} />;
    }

    return <ColumnSkeletonFixed {...props} />;
};
