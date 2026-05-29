/**
 * Unit coverage for parseTableColumns — orders columns as [left-pinned,
 * unpinned, right-pinned] while preserving original relative order, drops
 * disabled columns, and (when trimForMobile) drops the deprioritised
 * informational columns so the title + duration get the room on narrow
 * phone viewports.
 */
import { describe, expect, it } from 'vitest';

import { parseTableColumns } from '/@/renderer/components/item-list/helpers/parse-table-columns';
import { ItemTableListColumnConfig } from '/@/renderer/components/item-list/types';
import { TableColumn } from '/@/shared/types/types';

const col = (
    id: TableColumn,
    overrides: Partial<ItemTableListColumnConfig> = {},
): ItemTableListColumnConfig => ({
    align: 'start',
    id,
    isEnabled: true,
    pinned: null,
    width: 100,
    ...overrides,
});

const ids = (columns: ItemTableListColumnConfig[]): TableColumn[] => columns.map((c) => c.id);

describe('parseTableColumns', () => {
    it('orders left-pinned, then unpinned, then right-pinned, preserving relative order', () => {
        const columns = [
            col(TableColumn.DURATION),
            col(TableColumn.ROW_INDEX, { pinned: 'left' }),
            col(TableColumn.ACTIONS, { pinned: 'right' }),
            col(TableColumn.TITLE),
            col(TableColumn.IMAGE, { pinned: 'left' }),
        ];

        expect(ids(parseTableColumns(columns))).toEqual([
            TableColumn.ROW_INDEX,
            TableColumn.IMAGE,
            TableColumn.DURATION,
            TableColumn.TITLE,
            TableColumn.ACTIONS,
        ]);
    });

    it('drops columns with isEnabled === false', () => {
        const columns = [
            col(TableColumn.TITLE),
            col(TableColumn.DURATION, { isEnabled: false }),
            col(TableColumn.YEAR),
        ];
        expect(ids(parseTableColumns(columns))).toEqual([TableColumn.TITLE, TableColumn.YEAR]);
    });

    it('treats pinned: null and an unknown pinned value as unpinned', () => {
        const columns = [
            col(TableColumn.TITLE, { pinned: null }),
            col(TableColumn.DURATION, { pinned: undefined as unknown as null }),
        ];
        expect(ids(parseTableColumns(columns))).toEqual([TableColumn.TITLE, TableColumn.DURATION]);
    });

    it('keeps every enabled column by default (no mobile trimming)', () => {
        const columns = [col(TableColumn.TITLE), col(TableColumn.ALBUM), col(TableColumn.YEAR)];
        expect(ids(parseTableColumns(columns))).toEqual([
            TableColumn.TITLE,
            TableColumn.ALBUM,
            TableColumn.YEAR,
        ]);
    });

    it('trims deprioritised informational columns when trimForMobile is true', () => {
        const columns = [
            col(TableColumn.TITLE),
            col(TableColumn.ALBUM),
            col(TableColumn.YEAR),
            col(TableColumn.DURATION),
        ];
        // ALBUM and YEAR are deprioritised; TITLE and DURATION survive.
        expect(ids(parseTableColumns(columns, { trimForMobile: true }))).toEqual([
            TableColumn.TITLE,
            TableColumn.DURATION,
        ]);
    });

    it('preserves the structural album-group column under mobile trimming', () => {
        const columns = [
            col(TableColumn.TITLE),
            col(TableColumn.ALBUM_GROUP),
            col(TableColumn.ALBUM),
        ];
        expect(ids(parseTableColumns(columns, { trimForMobile: true }))).toEqual([
            TableColumn.TITLE,
            TableColumn.ALBUM_GROUP,
        ]);
    });

    it('returns an empty array for empty input', () => {
        expect(parseTableColumns([])).toEqual([]);
    });
});
