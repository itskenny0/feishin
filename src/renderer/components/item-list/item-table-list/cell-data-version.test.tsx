// Regression test: table cells must re-render when the backing data changes
// under a stable row index.
//
// In accessor (infinite-list) mode, `data` is a constant array and `getRowItem`
// is a stable function reading a mutated-in-place map — so when the item at a
// row changes (page fill, background revalidate, favorite toggle), every prop
// the cell memos compared was unchanged and the memo bailed, leaving stale rows
// until a remount. The grid path threads `dataVersion` for exactly this reason;
// the table cell memos must compare it too.

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createColumnCellComponent } from '/@/renderer/components/item-list/item-table-list/cell-component-factory';
import { MemoizedCellRouter } from '/@/renderer/components/item-list/item-table-list/memoized-cell-router';
import { LibraryItem } from '/@/shared/types/domain-types';
import { TableColumn } from '/@/shared/types/types';

vi.mock('/@/renderer/components/item-list/item-table-list/item-table-list-column', () => ({
    isSameCellStyle: (a: unknown, b: unknown) => a === b,
    ItemTableListColumn: (props: any) => (
        <div data-testid="cell">{String(props.getRowItem(props.rowIndex)?.name)}</div>
    ),
}));

const makeProps = (overrides: Record<string, unknown> = {}) => {
    const backing = new Map<number, { name: string }>([[0, { name: 'old' }]]);
    const style = { height: 30 };
    const columns = [{ id: TableColumn.TITLE }];
    return {
        backing,
        props: {
            columnIndex: 0,
            columns,
            data: [null],
            dataVersion: 0,
            getRowItem: (rowIndex: number) => backing.get(rowIndex),
            playlistId: undefined,
            rowIndex: 0,
            style,
            ...overrides,
        } as any,
    };
};

describe('table cell memo dataVersion', () => {
    it('column cell re-renders when dataVersion bumps after an in-place item change', () => {
        const Cell = createColumnCellComponent(TableColumn.TITLE, LibraryItem.SONG);
        const { backing, props } = makeProps();

        const { getByTestId, rerender } = render(<Cell {...props} />);
        expect(getByTestId('cell').textContent).toBe('old');

        // background revalidate mutates the backing map in place; every other
        // prop (data/style/columns/indices) keeps the same identity
        backing.set(0, { name: 'new' });
        rerender(<Cell {...props} dataVersion={1} />);

        expect(getByTestId('cell').textContent).toBe('new');
    });

    it('column cell still bails when nothing (including dataVersion) changed', () => {
        const Cell = createColumnCellComponent(TableColumn.TITLE, LibraryItem.SONG);
        const { backing, props } = makeProps();

        const { getByTestId, rerender } = render(<Cell {...props} />);
        backing.set(0, { name: 'new' });
        rerender(<Cell {...props} />);

        // same dataVersion → memo bails (this is the perf contract)
        expect(getByTestId('cell').textContent).toBe('old');
    });

    it('cell router re-renders when dataVersion bumps', () => {
        const { backing, props } = makeProps({
            columnCellComponents: new Map(),
        });

        const { getByTestId, rerender } = render(<MemoizedCellRouter {...props} />);
        expect(getByTestId('cell').textContent).toBe('old');

        backing.set(0, { name: 'new' });
        rerender(<MemoizedCellRouter {...props} dataVersion={1} />);

        expect(getByTestId('cell').textContent).toBe('new');
    });
});
