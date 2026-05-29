/**
 * Unit coverage for the row-play-control column resolver. The track-number /
 * row-index column doubles as the per-row play button on hover; this helper
 * decides which (if any) column owns that affordance. Only TRACK_NUMBER and
 * ROW_INDEX qualify, the first match in column order wins, and everything else
 * resolves to null.
 */
import { describe, expect, it } from 'vitest';

import {
    getRowPlayControlColumnId,
    isRowPlayControlColumn,
} from '/@/renderer/components/item-list/helpers/get-row-play-control-column';
import { TableColumn } from '/@/shared/types/types';

describe('getRowPlayControlColumnId', () => {
    it('returns TRACK_NUMBER when present', () => {
        expect(
            getRowPlayControlColumnId([
                { id: TableColumn.TITLE },
                { id: TableColumn.TRACK_NUMBER },
            ]),
        ).toBe(TableColumn.TRACK_NUMBER);
    });

    it('returns ROW_INDEX when present', () => {
        expect(
            getRowPlayControlColumnId([{ id: TableColumn.ROW_INDEX }, { id: TableColumn.TITLE }]),
        ).toBe(TableColumn.ROW_INDEX);
    });

    it('returns the first qualifying column in column order', () => {
        expect(
            getRowPlayControlColumnId([
                { id: TableColumn.TRACK_NUMBER },
                { id: TableColumn.ROW_INDEX },
            ]),
        ).toBe(TableColumn.TRACK_NUMBER);
        expect(
            getRowPlayControlColumnId([
                { id: TableColumn.ROW_INDEX },
                { id: TableColumn.TRACK_NUMBER },
            ]),
        ).toBe(TableColumn.ROW_INDEX);
    });

    it('returns null when no qualifying column is present', () => {
        expect(
            getRowPlayControlColumnId([{ id: TableColumn.TITLE }, { id: TableColumn.DURATION }]),
        ).toBeNull();
    });

    it('returns null for an empty column list', () => {
        expect(getRowPlayControlColumnId([])).toBeNull();
    });
});

describe('isRowPlayControlColumn', () => {
    it('is true only for the resolved owner column', () => {
        const columns = [{ id: TableColumn.TRACK_NUMBER }, { id: TableColumn.ROW_INDEX }];
        expect(isRowPlayControlColumn(TableColumn.TRACK_NUMBER, columns)).toBe(true);
        // ROW_INDEX exists but TRACK_NUMBER wins, so it is not the owner.
        expect(isRowPlayControlColumn(TableColumn.ROW_INDEX, columns)).toBe(false);
    });

    it('is false for non-qualifying columns', () => {
        const columns = [{ id: TableColumn.TRACK_NUMBER }];
        expect(isRowPlayControlColumn(TableColumn.TITLE, columns)).toBe(false);
    });

    it('is false when there is no owner at all', () => {
        const columns = [{ id: TableColumn.TITLE }];
        expect(isRowPlayControlColumn(TableColumn.TITLE, columns)).toBe(false);
    });
});
