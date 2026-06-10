import React, { useMemo } from 'react';
import { CellComponentProps } from 'react-window-v2';

import { createColumnCellComponents } from './cell-component-factory';
import { TableItemProps } from './item-table-list';
import { isSameCellStyle, ItemTableListColumn } from './item-table-list-column';
import { getListDataVersion, subscribeListDataVersion } from './table-version-store';

import { LibraryItem } from '/@/shared/types/domain-types';
import { TableColumn } from '/@/shared/types/types';

interface MemoizedCellRouterProps extends CellComponentProps<TableItemProps> {
    columnCellComponents: Map<TableColumn, React.ComponentType<CellComponentProps<TableItemProps>>>;
}

const MemoizedCellRouterBase = (props: MemoizedCellRouterProps) => {
    // Live module-scope data version: react-window v2 does not re-invoke
    // mounted cells when cellProps changes, and the prop chain breaks across
    // suspense-retried loader instances — cells that mounted before their
    // page's data landed froze as skeletons forever. Subscribing HERE (the
    // router renders for every routed cell) and forwarding the version as
    // the child's dataVersion prop makes the memoized column components
    // re-render on every page write and re-read their rows.
    const liveVersion = React.useSyncExternalStore(
        subscribeListDataVersion,
        getListDataVersion,
        getListDataVersion,
    );
    const columnType = props.columns[props.columnIndex]?.id as TableColumn;
    const ColumnComponent = props.columnCellComponents.get(columnType);

    if (ColumnComponent) {
        // eslint-disable-next-line react-hooks/static-components
        return <ColumnComponent {...props} dataVersion={liveVersion} />;
    }

    return <ItemTableListColumn {...props} dataVersion={liveVersion} />;
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
