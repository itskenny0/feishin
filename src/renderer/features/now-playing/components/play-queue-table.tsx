import { ComponentProps, forwardRef } from 'react';

import { ItemTableList } from '/@/renderer/components/item-list/item-table-list/item-table-list';
import { ItemTableListColumn } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { ItemListHandle } from '/@/renderer/components/item-list/types';

// The heavy item-table-list engine (~186KB: react-window-v2, motion/react, the
// full column router) lives behind this default export so it can be code-split
// out of the renderer entry chunk via React.lazy() in play-queue.tsx. The
// always-mounted sidebar/popover/playerbar queue must not statically drag the
// engine into the entry bundle.
export type PlayQueueTableProps = Omit<
    ComponentProps<typeof ItemTableList>,
    'CellComponent' | 'ref'
>;

const PlayQueueTable = forwardRef<ItemListHandle, PlayQueueTableProps>((props, ref) => {
    return <ItemTableList {...props} CellComponent={ItemTableListColumn} ref={ref} />;
});

PlayQueueTable.displayName = 'PlayQueueTable';

export default PlayQueueTable;
