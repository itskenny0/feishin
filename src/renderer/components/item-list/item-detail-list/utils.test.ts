/**
 * Unit coverage for the item-detail-list column-geometry helpers: fixed-width
 * lookups, hover-only gating, and horizontal-padding suppression for the
 * icon-style columns (actions / favorite / rating).
 */
import { describe, expect, it } from 'vitest';

import {
    getTrackColumnFixed,
    isNoHorizontalPaddingColumn,
    isTrackColumnHoverOnly,
    shouldShowHoverOnlyColumnContent,
} from '/@/renderer/components/item-list/item-detail-list/utils';
import { TableColumn } from '/@/shared/types/types';

describe('getTrackColumnFixed', () => {
    it('returns the configured fixed width for a known fixed column', () => {
        expect(getTrackColumnFixed(TableColumn.DURATION)).toEqual({
            fixedWidth: 72,
            isFixedColumn: true,
        });
        expect(getTrackColumnFixed(TableColumn.ACTIONS)).toEqual({
            fixedWidth: 32,
            isFixedColumn: true,
        });
    });

    it('reports non-fixed for a column with no configured width', () => {
        expect(getTrackColumnFixed(TableColumn.TITLE)).toEqual({
            fixedWidth: 0,
            isFixedColumn: false,
        });
    });
});

describe('isNoHorizontalPaddingColumn', () => {
    it('is true for the icon-style columns', () => {
        expect(isNoHorizontalPaddingColumn(TableColumn.ACTIONS)).toBe(true);
        expect(isNoHorizontalPaddingColumn(TableColumn.USER_FAVORITE)).toBe(true);
        expect(isNoHorizontalPaddingColumn(TableColumn.USER_RATING)).toBe(true);
    });

    it('is false for text columns', () => {
        expect(isNoHorizontalPaddingColumn(TableColumn.TITLE)).toBe(false);
        expect(isNoHorizontalPaddingColumn(TableColumn.DURATION)).toBe(false);
    });
});

describe('isTrackColumnHoverOnly', () => {
    it('is true for actions / favorite / rating', () => {
        expect(isTrackColumnHoverOnly(TableColumn.ACTIONS)).toBe(true);
        expect(isTrackColumnHoverOnly(TableColumn.USER_FAVORITE)).toBe(true);
        expect(isTrackColumnHoverOnly(TableColumn.USER_RATING)).toBe(true);
    });

    it('is false for everything else', () => {
        expect(isTrackColumnHoverOnly(TableColumn.TITLE)).toBe(false);
    });
});

describe('shouldShowHoverOnlyColumnContent', () => {
    it('always shows content for non-hover-only columns', () => {
        expect(shouldShowHoverOnlyColumnContent(TableColumn.TITLE, false, {})).toBe(true);
    });

    it('shows hover-only content while the row is hovered', () => {
        expect(shouldShowHoverOnlyColumnContent(TableColumn.ACTIONS, true, {})).toBe(true);
    });

    it('hides the actions column when not hovered', () => {
        expect(shouldShowHoverOnlyColumnContent(TableColumn.ACTIONS, false, {})).toBe(false);
    });

    it('keeps a favorited row visible even when not hovered', () => {
        expect(
            shouldShowHoverOnlyColumnContent(TableColumn.USER_FAVORITE, false, {
                userFavorite: true,
            }),
        ).toBe(true);
    });

    it('hides the favorite column when explicitly not favorited and not hovered', () => {
        expect(
            shouldShowHoverOnlyColumnContent(TableColumn.USER_FAVORITE, false, {
                userFavorite: false,
            }),
        ).toBe(false);
    });

    it('keeps a rated row visible even when not hovered', () => {
        expect(
            shouldShowHoverOnlyColumnContent(TableColumn.USER_RATING, false, { userRating: 4 }),
        ).toBe(true);
    });

    it('hides the rating column for a zero / null rating when not hovered', () => {
        expect(
            shouldShowHoverOnlyColumnContent(TableColumn.USER_RATING, false, { userRating: 0 }),
        ).toBe(false);
        expect(
            shouldShowHoverOnlyColumnContent(TableColumn.USER_RATING, false, { userRating: null }),
        ).toBe(false);
    });
});
