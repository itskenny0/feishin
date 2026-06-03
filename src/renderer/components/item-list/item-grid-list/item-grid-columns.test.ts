/**
 * Unit coverage for the library grid column-count mapping.
 *
 * Tablet regression (S1): at tablet content widths (~540-700px, common when
 * the desktop shell renders with an expanded 240px sidebar) the grid used to
 * fall into the 2-column branch, producing oversized covers on the device
 * class with the most room. Intermediate 3-col (>=540) and 4-col (>=700) steps
 * were added.
 *
 * Phone density (S2): phones used to collapse to 1 column below 380 and only
 * 2 columns up to 540, rendering one viewport-filling cover. Re-tuned so small
 * phones (<384) show 2 columns and larger phones (384-539) show 3, matching
 * the density of the Spotify / Apple Music library grids. The >=540
 * tablet/desktop tiers are unchanged.
 */
import { describe, expect, it } from 'vitest';

import { getDynamicItemsPerRow } from '/@/renderer/components/item-list/item-grid-list/item-grid-list';

describe('getDynamicItemsPerRow', () => {
    it('uses 2 columns on small phones (<384)', () => {
        expect(getDynamicItemsPerRow(320)).toBe(2);
        expect(getDynamicItemsPerRow(360)).toBe(2);
        expect(getDynamicItemsPerRow(383)).toBe(2);
    });

    it('uses 3 columns on larger phones up to the first tablet step (384-539)', () => {
        expect(getDynamicItemsPerRow(384)).toBe(3);
        expect(getDynamicItemsPerRow(390)).toBe(3);
        expect(getDynamicItemsPerRow(430)).toBe(3);
        expect(getDynamicItemsPerRow(539)).toBe(3);
    });

    it('gives 3 columns at narrow tablet content widths (540-599)', () => {
        // The new intermediate step: previously these fell to 2 columns.
        expect(getDynamicItemsPerRow(540)).toBe(3);
        expect(getDynamicItemsPerRow(595)).toBe(3);
    });

    it('keeps 3 columns through the small tier (600-699)', () => {
        expect(getDynamicItemsPerRow(600)).toBe(3);
        expect(getDynamicItemsPerRow(699)).toBe(3);
    });

    it('gives 4 columns at mid tablet content widths (700-767)', () => {
        // The new intermediate step: previously these fell to 2 columns.
        expect(getDynamicItemsPerRow(700)).toBe(4);
        expect(getDynamicItemsPerRow(767)).toBe(4);
    });

    it('matches the desktop ladder at the larger breakpoints', () => {
        expect(getDynamicItemsPerRow(768)).toBe(4);
        expect(getDynamicItemsPerRow(960)).toBe(5);
        expect(getDynamicItemsPerRow(1200)).toBe(6);
        expect(getDynamicItemsPerRow(1440)).toBe(7);
        expect(getDynamicItemsPerRow(1920)).toBe(8);
        expect(getDynamicItemsPerRow(2560)).toBe(10);
    });

    it('scales down by 0.75 (rounded, min 1) for the "large" card size', () => {
        // 768 -> 4 cols, large => round(3) = 3.
        expect(getDynamicItemsPerRow(768, 'large')).toBe(3);
        // 540 -> 3 cols, large => round(2.25) = 2.
        expect(getDynamicItemsPerRow(540, 'large')).toBe(2);
        // 320 -> 2 cols (small phone), large => round(1.5) = 2.
        expect(getDynamicItemsPerRow(320, 'large')).toBe(2);
        // 390 -> 3 cols (larger phone), large => round(2.25) = 2.
        expect(getDynamicItemsPerRow(390, 'large')).toBe(2);
    });

    it('treats "compact" and "default" sizes the same as no size', () => {
        expect(getDynamicItemsPerRow(700, 'compact')).toBe(4);
        expect(getDynamicItemsPerRow(700, 'default')).toBe(4);
        expect(getDynamicItemsPerRow(700)).toBe(4);
    });
});
