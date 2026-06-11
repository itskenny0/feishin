import { describe, expect, it } from 'vitest';

import { isSameCellStyle } from '/@/renderer/components/item-list/item-table-list/item-table-list-column';

/**
 * react-window-v2 hands every grid render a fresh `style` object, so the cell
 * memo comparators must compare layout geometry by value (not reference) to
 * bail out on unrelated re-renders. These pin that contract.
 */
describe('isSameCellStyle', () => {
    it('returns true for the same reference', () => {
        const style = { height: 4, left: 2, top: 1, width: 3 };
        expect(isSameCellStyle(style, style)).toBe(true);
    });

    it('returns true for distinct objects with identical geometry', () => {
        expect(
            isSameCellStyle(
                { height: 4, left: 2, position: 'absolute', top: 1, width: 3 },
                { height: 4, left: 2, position: 'absolute', top: 1, width: 3 },
            ),
        ).toBe(true);
    });

    it('returns false when any geometry field differs', () => {
        expect(isSameCellStyle({ top: 1 }, { top: 2 })).toBe(false);
        expect(isSameCellStyle({ left: 1 }, { left: 2 })).toBe(false);
        expect(isSameCellStyle({ width: 1 }, { width: 2 })).toBe(false);
        expect(isSameCellStyle({ height: 1 }, { height: 2 })).toBe(false);
        expect(isSameCellStyle({ position: 'absolute' }, { position: 'relative' })).toBe(false);
    });

    it('handles undefined inputs', () => {
        expect(isSameCellStyle(undefined, undefined)).toBe(true);
        expect(isSameCellStyle({ top: 1 }, undefined)).toBe(false);
        expect(isSameCellStyle(undefined, { top: 1 })).toBe(false);
    });

    // react-window-v2 positions cells ONLY via transform (RTL variant via
    // `right`) — it never writes `top`. Missing these fields let a cell bail
    // out of its memo while its offset changed, leaving it painted at a stale
    // position stacked over the row that moved (queue panel + tracks table
    // double-paint, device 2026-06-11).
    it('returns false when only the transform differs', () => {
        expect(
            isSameCellStyle(
                { height: 64, left: 0, transform: 'translate(0px, 512px)', width: 320 },
                { height: 64, left: 0, transform: 'translate(0px, 576px)', width: 320 },
            ),
        ).toBe(false);
    });

    it('returns false when only `right` differs (RTL/pinned variant)', () => {
        expect(isSameCellStyle({ right: 0 }, { right: 48 })).toBe(false);
    });

    it('returns true when transform and geometry are identical', () => {
        expect(
            isSameCellStyle(
                { height: 64, transform: 'translate(0px, 512px)', width: 320 },
                { height: 64, transform: 'translate(0px, 512px)', width: 320 },
            ),
        ).toBe(true);
    });
});
