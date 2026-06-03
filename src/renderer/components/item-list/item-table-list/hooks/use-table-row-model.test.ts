import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useTableRowModel } from './use-table-row-model';

/**
 * Locks in the header-offset invariant of the table row model.
 *
 * Bug-hunt #2 flagged `item-table-list.tsx`'s `getRowItem` fallback
 * (`dataWithGroups[rowIndex]`, header enabled, no groups, no `getItem`) as an
 * off-by-one — claiming row 0 should map to item 0 via `dataIndex` instead of
 * `rowIndex`. That is a FALSE POSITIVE: `dataWithGroups` is the *expanded* row
 * model and already carries the header at index 0, so `dataWithGroups[rowIndex]`
 * is correct and `dataWithGroups[dataIndex]` (= rowIndex - 1) would return the
 * header `null` for the first data row.
 *
 * These tests pin that contract so a future "fix" to either side trips the
 * suite instead of silently shifting every row by one.
 */
describe('useTableRowModel header offset', () => {
    it('prepends a header placeholder when enableHeader is true (no groups)', () => {
        const data = ['item0', 'item1', 'item2'];
        const { result } = renderHook(() =>
            useTableRowModel({ data, enableHeader: true, groups: undefined }),
        );

        const { dataWithGroups } = result.current;

        // Row 0 is the header placeholder, row 1 is the first data item.
        expect(dataWithGroups[0]).toBeNull();
        expect(dataWithGroups[1]).toBe('item0');
        expect(dataWithGroups[2]).toBe('item1');
        expect(dataWithGroups[3]).toBe('item2');
        expect(dataWithGroups).toHaveLength(4);
    });

    it('does not offset when enableHeader is false (no groups)', () => {
        const data = ['item0', 'item1'];
        const { result } = renderHook(() =>
            useTableRowModel({ data, enableHeader: false, groups: undefined }),
        );

        const { dataWithGroups } = result.current;

        expect(dataWithGroups[0]).toBe('item0');
        expect(dataWithGroups[1]).toBe('item1');
        expect(dataWithGroups).toHaveLength(2);
    });

    it('row index 1 resolves to data index 0 via dataWithGroups[rowIndex] with a header', () => {
        // This is the exact accessor the item-table-list getRowItem fallback uses.
        const data = ['first', 'second'];
        const { result } = renderHook(() =>
            useTableRowModel({ data, enableHeader: true, groups: undefined }),
        );

        const { dataWithGroups } = result.current;
        const firstDataRowIndex = 1;

        // Correct: indexing the expanded model by the raw row index.
        expect(dataWithGroups[firstDataRowIndex]).toBe('first');
        // Wrong (the proposed "fix"): rowIndex - 1 would land on the header.
        expect(dataWithGroups[firstDataRowIndex - 1]).toBeNull();
    });
});
