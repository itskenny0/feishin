import {
    ColumnNullFallback,
    ColumnSkeletonVariable,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { LibraryItem } from '/@/shared/types/domain-types';

const folderNameFromPath = (item: { _itemType?: LibraryItem; path?: null | string }): string => {
    const path = item.path;
    if (!path) return '';
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) return '';
    // For a song the path ends in a filename, so the containing folder is the
    // second-to-last segment. For a folder the path ends in the folder itself.
    if (item._itemType === LibraryItem.SONG) {
        return segments[segments.length - 2] || '';
    }
    return segments[segments.length - 1] || '';
};

export const FolderNameColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];

    if (!rowItem) {
        return <ColumnSkeletonVariable {...props} />;
    }

    const name = folderNameFromPath(rowItem);

    if (name) {
        return (
            <TableColumnTextContainer {...props}>
                <span>{name}</span>
            </TableColumnTextContainer>
        );
    }

    return <ColumnNullFallback {...props} />;
};
