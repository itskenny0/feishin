/**
 * Unit coverage for appendLayoutFillColumn — the helper that appends a
 * zero-width auto-sizing "filler" column so a fixed-width table still spans the
 * full container. The filler must only be added when the table is NOT
 * auto-fitting and no enabled, unpinned column already absorbs the slack
 * (i.e. none is autoSize). All early-return guards are exercised.
 */
import { describe, expect, it } from 'vitest';

import { appendLayoutFillColumn } from '/@/renderer/components/item-list/helpers/append-layout-fill-column';
import { ItemTableListColumnConfig } from '/@/renderer/components/item-list/types';
import { TableColumn } from '/@/shared/types/types';

const col = (overrides: Partial<ItemTableListColumnConfig> = {}): ItemTableListColumnConfig => ({
    align: 'start',
    id: TableColumn.TITLE,
    isEnabled: true,
    pinned: null,
    width: 100,
    ...overrides,
});

describe('appendLayoutFillColumn', () => {
    it('appends a filler column for fixed-width tables with no auto-size column', () => {
        const columns = [col({ id: TableColumn.TITLE }), col({ id: TableColumn.DURATION })];
        const result = appendLayoutFillColumn(columns, false);

        expect(result).toHaveLength(3);
        expect(result[result.length - 1].id).toBe(TableColumn.LAYOUT_FILL);
        // The original array must not be mutated.
        expect(columns).toHaveLength(2);
    });

    it('returns columns unchanged when autoFitColumns is true', () => {
        const columns = [col({ id: TableColumn.TITLE })];
        expect(appendLayoutFillColumn(columns, true)).toBe(columns);
    });

    it('returns columns unchanged when there are no columns', () => {
        const columns: ItemTableListColumnConfig[] = [];
        expect(appendLayoutFillColumn(columns, false)).toBe(columns);
    });

    it('returns columns unchanged when no unpinned enabled column exists', () => {
        const columns = [col({ id: TableColumn.TITLE, pinned: 'left' })];
        expect(appendLayoutFillColumn(columns, false)).toBe(columns);
    });

    it('returns columns unchanged when an unpinned enabled column is already autoSize', () => {
        const columns = [col({ autoSize: true, id: TableColumn.TITLE })];
        expect(appendLayoutFillColumn(columns, false)).toBe(columns);
    });

    it('ignores a disabled column when deciding whether an auto-size slack column exists', () => {
        // The only autoSize column is disabled, so the filler is still needed.
        const columns = [
            col({ autoSize: true, id: TableColumn.TITLE, isEnabled: false }),
            col({ id: TableColumn.DURATION }),
        ];
        const result = appendLayoutFillColumn(columns, false);
        expect(result[result.length - 1].id).toBe(TableColumn.LAYOUT_FILL);
    });
});
