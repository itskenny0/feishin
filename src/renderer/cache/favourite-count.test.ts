// Contract tests for `cacheFavoriteCount` — the decision a list-count query's
// fromCache makes for a favourite-filtered count.
//
// The bug this pins: every list-count query's favourite branch returned the raw
// `favRows.filter(IsFavorite).length` INCLUDING 0 as an authoritative cache
// answer. Under sync-first a cached 0 suppresses the network fallback, so a
// favourite-filtered library view (Albums/Songs/Artists) stayed stuck at
// "0 / nothing here" whenever the favourites cache was empty or had been wiped
// — and an online refresh could not heal it. A cached favourite count of 0 must
// instead defer to the network (return undefined), exactly like the sibling
// single-album / single-artist count branches already do.

import { describe, expect, it } from 'vitest';

import { cacheFavoriteCount } from '/@/renderer/cache/local-filter';

describe('cacheFavoriteCount — favorite: true', () => {
    it('returns the count when there ARE cached favourites', () => {
        expect(cacheFavoriteCount({ favorite: true, favoriteCount: 34, totalCount: 1278 })).toBe(
            34,
        );
    });

    it('returns undefined (defer to network) when the cached favourite count is 0', () => {
        // The trap: a wiped/unsynced favourites table reads as 0. Serving 0
        // would let sync-first pin the view to empty forever.
        expect(
            cacheFavoriteCount({ favorite: true, favoriteCount: 0, totalCount: 1278 }),
        ).toBeUndefined();
    });
});

describe('cacheFavoriteCount — favorite: false (non-favourites)', () => {
    it('returns total minus favourites', () => {
        expect(cacheFavoriteCount({ favorite: false, favoriteCount: 34, totalCount: 1278 })).toBe(
            1244,
        );
    });

    it('returns undefined when nothing is cached (cannot answer authoritatively)', () => {
        expect(
            cacheFavoriteCount({ favorite: false, favoriteCount: 0, totalCount: 0 }),
        ).toBeUndefined();
    });
});
