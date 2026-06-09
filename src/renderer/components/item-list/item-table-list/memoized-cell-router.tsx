import React, { useMemo } from 'react';
import { CellComponentProps } from 'react-window-v2';

import { createColumnCellComponents } from './cell-component-factory';
import { TableItemProps } from './item-table-list';
import { isSameCellStyle, ItemTableListColumn } from './item-table-list-column';

import { LibraryItem } from '/@/shared/types/domain-types';
import { TableColumn } from '/@/shared/types/types';

interface MemoizedCellRouterProps extends CellComponentProps<TableItemProps> {
    columnCellComponents: Map<TableColumn, React.ComponentType<CellComponentProps<TableItemProps>>>;
}

const MemoizedCellRouterBase = (props: MemoizedCellRouterProps) => {
    const columnType = props.columns[props.columnIndex]?.id as TableColumn;
    const ColumnComponent = props.columnCellComponents.get(columnType);

    if (ColumnComponent) {
        // eslint-disable-next-line react-hooks/static-components
        return <ColumnComponent {...props} />;
    }

    return <ItemTableListColumn {...props} />;
};

// Name says "memoized" — actually wrap it. The inner ColumnComponent is itself
// memoized, but without this the router re-runs (and re-creates the child
// element) on every parent grid render even when nothing relevant changed.
export const MemoizedCellRouter = React.memo(MemoizedCellRouterBase, (prevProps, nextProps) => {
    return (
        prevProps.rowIndex === nextProps.rowIndex &&
        prevProps.columnIndex === nextProps.columnIndex &&
        prevProps.data === nextProps.data &&
        // See cell-component-factory: accessor-mode item changes are only
        // visible through the version counter.
        prevProps.dataVersion === nextProps.dataVersion &&
        isSameCellStyle(prevProps.style, nextProps.style) &&
        prevProps.columns === nextProps.columns &&
        prevProps.columnCellComponents === nextProps.columnCellComponents &&
        prevProps.playlistId === nextProps.playlistId
    );
});

export const useColumnCellComponents = (
    columns: TableColumn[],
    itemType: LibraryItem,
): Map<TableColumn, React.ComponentType<CellComponentProps<TableItemProps>>> => {
    const columnsKey = useMemo(() => columns.join(','), [columns]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    return useMemo(() => createColumnCellComponents(columns, itemType), [columnsKey, itemType]);
};
