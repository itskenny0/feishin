import { ItemDetailRowPlayControlCell } from './row-play-control-cell';
import { ItemDetailListCellProps } from './types';

import { isRowPlayControlColumn } from '/@/renderer/components/item-list/helpers/get-row-play-control-column';
import { TableColumn } from '/@/shared/types/types';

export const RowIndexColumn = ({ columns, rowIndex, song }: ItemDetailListCellProps) => {
    const label = String((rowIndex ?? 0) + 1);

    if (!columns || !isRowPlayControlColumn(TableColumn.ROW_INDEX, columns)) {
        return label;
    }

    return <ItemDetailRowPlayControlCell label={label} song={song} />;
};
