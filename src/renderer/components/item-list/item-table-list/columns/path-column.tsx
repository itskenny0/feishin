import {
    ColumnNullFallback,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';

export const PathColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];

    if (!rowItem) {
        return <ColumnNullFallback {...props} />;
    }

    const row: string | undefined = (rowItem as any)?.[props.columns[props.columnIndex].id];

    if (typeof row === 'string' && row) {
        return (
            <TableColumnTextContainer {...props}>
                <span>{row}</span>
            </TableColumnTextContainer>
        );
    }

    return <ColumnNullFallback {...props} />;
};
