// The INNER ItemTableListColumn memo must compare dataVersion — the factory
// wrappers re-render on a bump, but if this comparator bails the bump never
// reaches the actual cell. Its prevItem/nextItem check reads the SAME live
// map twice and always agrees, so without dataVersion every cell that
// mounted before its page's data landed froze as a skeleton forever
// (playlists table, device 2026-06-10).

import { describe, expect, it } from 'vitest';

import { itemTableListColumnPropsEqual } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { TableColumn } from '/@/shared/types/types';

describe('itemTableListColumnPropsEqual', () => {
    it('reports inequality when only dataVersion changed', () => {
        const backing = new Map<number, { name: string }>([[0, { name: 'x' }]]);
        const base = {
            columnIndex: 0,
            columns: [{ id: TableColumn.TITLE }],
            data: [null],
            dataVersion: 0,
            getRowItem: (rowIndex: number) => backing.get(rowIndex),
            rowIndex: 0,
            style: { height: 30 },
        } as never;
        expect(itemTableListColumnPropsEqual(base, { ...(base as object) } as never)).toBe(true);
        expect(
            itemTableListColumnPropsEqual(base, {
                ...(base as object),
                dataVersion: 1,
            } as never),
        ).toBe(false);
    });
});
