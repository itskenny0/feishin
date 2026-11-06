import {
    ColumnNullFallback,
    ItemTableListInnerColumn,
    TableColumnTextContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { LibraryItem } from '/@/shared/types/domain-types';
import { lastPathSegment, parentPathSegment } from '/@/shared/utils/album-folder-from-path';

// A song's path ends in its filename; a folder's path ends in the folder itself.
const folderNameFromPath = (item: { _itemType?: LibraryItem; path?: null | string }) =>
    item._itemType === LibraryItem.SONG ? parentPathSegment(item.path) : lastPathSegment(item.path);

export const FolderNameColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];

    if (!rowItem) {
        return <ColumnNullFallback {...props} />;
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
