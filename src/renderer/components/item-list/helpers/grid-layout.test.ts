import { describe, expect, it } from 'vitest';

import {
    getDynamicItemsPerRow,
    GRID_CARD_CORNER_RADIUS_VALUE,
} from '/@/renderer/components/item-list/helpers/grid-layout';

describe('grid-layout', () => {
    describe('getDynamicItemsPerRow', () => {
        it('returns 2 columns for small phones (< 384)', () => {
            expect(getDynamicItemsPerRow(320)).toBe(2);
            expect(getDynamicItemsPerRow(360)).toBe(2);
            expect(getDynamicItemsPerRow(383)).toBe(2);
        });

        it('returns 3 columns for larger phones (384-539)', () => {
            expect(getDynamicItemsPerRow(384)).toBe(3);
            expect(getDynamicItemsPerRow(430)).toBe(3);
            expect(getDynamicItemsPerRow(539)).toBe(3);
        });

        it('steps up through tablet/desktop tiers', () => {
            expect(getDynamicItemsPerRow(700)).toBe(4);
            expect(getDynamicItemsPerRow(768)).toBe(4);
            expect(getDynamicItemsPerRow(960)).toBe(5);
            expect(getDynamicItemsPerRow(1200)).toBe(6);
            expect(getDynamicItemsPerRow(1440)).toBe(7);
            expect(getDynamicItemsPerRow(1920)).toBe(8);
            expect(getDynamicItemsPerRow(2560)).toBe(10);
        });

        it('scales down for the large card size', () => {
            expect(getDynamicItemsPerRow(768, 'large')).toBe(3);
            expect(getDynamicItemsPerRow(320, 'large')).toBe(2);
        });
    });

    describe('GRID_CARD_CORNER_RADIUS_VALUE', () => {
        it('maps each corner-radius setting onto a CSS length', () => {
            expect(GRID_CARD_CORNER_RADIUS_VALUE.pill).toBe('var(--theme-radius-pill)');
            expect(GRID_CARD_CORNER_RADIUS_VALUE['rounded-md']).toBe('var(--theme-radius-md)');
            expect(GRID_CARD_CORNER_RADIUS_VALUE.square).toBe('0px');
        });
    });
});
