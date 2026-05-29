/**
 * Unit coverage for the GridCarousel page-clamp logic.
 *
 * Regression: when the underlying `cards` array shrinks (a random-carousel
 * refresh returning fewer items, or `excludeIds` filtering out the current
 * page's items), `currentPage.page` was never reset. The slice then ran past
 * the end and the carousel rendered an empty page with both nav arrows
 * disabled, stranding the user. `clampCarouselPage` snaps back to the last
 * non-empty page.
 */
import { describe, expect, it } from 'vitest';

import { clampCarouselPage } from '/@/renderer/components/grid-carousel/grid-carousel-v2';

describe('clampCarouselPage', () => {
    it('leaves the page unchanged when it still has content', () => {
        // page 2, pageSize 4 => needs >= 9 cards; 12 cards is fine.
        expect(clampCarouselPage(2, 12, 4)).toBe(2);
    });

    it('snaps to the last non-empty page when cards shrink past the page', () => {
        // page 2 (cards 8-11), pageSize 4, but only 6 cards remain after a
        // refresh => last page is ceil(6/4)-1 = 1.
        expect(clampCarouselPage(2, 6, 4)).toBe(1);
    });

    it('snaps to page 0 when the card set empties entirely', () => {
        expect(clampCarouselPage(3, 0, 4)).toBe(0);
    });

    it('snaps to page 0 when only a partial first page remains', () => {
        // 2 cards, pageSize 5 => last page 0.
        expect(clampCarouselPage(4, 2, 5)).toBe(0);
    });

    it('does NOT clamp while an infinite query still has more pages pending', () => {
        // Even though the currently-loaded cards do not fill page 3, the
        // infinite query is mid-fetch (hasNextPage === true), so advancing is
        // legitimate and must not be undone.
        expect(clampCarouselPage(3, 4, 4, true)).toBe(3);
    });

    it('clamps once the infinite query is exhausted (hasNextPage false)', () => {
        expect(clampCarouselPage(3, 4, 4, false)).toBe(0);
    });

    it('returns the page unchanged when pageSize is not yet meaningful', () => {
        // Before the container query resolves, pageSize can be 0; never divide
        // by it.
        expect(clampCarouselPage(5, 10, 0)).toBe(5);
    });

    it('keeps the exact boundary page that is still full', () => {
        // 8 cards, pageSize 4 => pages 0 and 1 both full; last page is 1.
        expect(clampCarouselPage(1, 8, 4)).toBe(1);
        expect(clampCarouselPage(2, 8, 4)).toBe(1);
    });
});
