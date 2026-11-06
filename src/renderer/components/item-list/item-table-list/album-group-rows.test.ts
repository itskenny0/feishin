// Album-group row helpers must find the group's extent through `getRowItem`.
// Infinite (accessor-mode) tables hand cells `data = [null]` (just the header
// slot), so a `data.length` bound made every row its own one-row group: the
// group header showed one track and every row was grown to fit the artwork.

import { describe, expect, it } from 'vitest';

import {
    getAlbumGroupRowCount,
    getAlbumGroupStartRowIndex,
    isLastInAlbumGroup,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';

// Header at row 0, then album A on rows 1-3 and album B on rows 4-5. In
// accessor mode the cells' `data` is `[null]`, so only getRowItem knows the rows.
const rows = [null, { album: 'A' }, { album: 'A' }, { album: 'A' }, { album: 'B' }, { album: 'B' }];
const getRowItem = (rowIndex: number) => rows[rowIndex];

describe('album group rows', () => {
    it('counts every row of the group', () => {
        expect(getAlbumGroupRowCount(1, getRowItem, true)).toBe(3);
        expect(getAlbumGroupRowCount(2, getRowItem, true)).toBe(3);
        expect(getAlbumGroupRowCount(5, getRowItem, true)).toBe(2);
        expect(getAlbumGroupStartRowIndex(3, getRowItem, true)).toBe(1);
    });

    it('only the final row of a group is its last row', () => {
        expect(isLastInAlbumGroup(1, getRowItem)).toBe(false);
        expect(isLastInAlbumGroup(2, getRowItem)).toBe(false);
        expect(isLastInAlbumGroup(3, getRowItem)).toBe(true);
        expect(isLastInAlbumGroup(4, getRowItem)).toBe(false);
        expect(isLastInAlbumGroup(5, getRowItem)).toBe(true);
    });
});
