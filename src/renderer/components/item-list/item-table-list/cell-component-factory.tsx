import React from 'react';
import { CellComponentProps } from 'react-window-v2';

import { TableItemProps } from '/@/renderer/components/item-list/item-table-list/item-table-list';
import {
    isSameCellStyle,
    ItemTableListColumn,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { LibraryItem } from '/@/shared/types/domain-types';
import { TableColumn } from '/@/shared/types/types';

export const createColumnCellComponent = (
    columnType: TableColumn,
    itemType: LibraryItem,
): React.ComponentType<CellComponentProps<TableItemProps>> => {
    return React.memo(
        (props: CellComponentProps<TableItemProps>) => {
            return <ItemTableListColumn {...props} columnType={columnType} itemType={itemType} />;
        },
        (prevProps, nextProps) => {
            return (
                prevProps.rowIndex === nextProps.rowIndex &&
                prevProps.columnIndex === nextProps.columnIndex &&
                prevProps.data === nextProps.data &&
                // In accessor mode `data` is constant and `getRowItem` reads a
                // mutated-in-place map, so the version counter is the only prop
                // that reflects an item change at a stable row index.
                prevProps.dataVersion === nextProps.dataVersion &&
                isSameCellStyle(prevProps.style, nextProps.style) &&
                prevProps.columns === nextProps.columns &&
                prevProps.playlistId === nextProps.playlistId
            );
        },
    );
};

export const createColumnCellComponents = (
    columns: TableColumn[],
    itemType: LibraryItem,
): Map<TableColumn, React.ComponentType<CellComponentProps<TableItemProps>>> => {
    const componentMap = new Map<
        TableColumn,
        React.ComponentType<CellComponentProps<TableItemProps>>
    >();

    columns.forEach((columnType) => {
        componentMap.set(columnType, createColumnCellComponent(columnType, itemType));
    });

    return componentMap;
};
