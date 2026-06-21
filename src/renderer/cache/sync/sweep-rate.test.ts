// Contract test for sweepItemsPerSec — the items/sec rate a sweep reports.
//
// The bug this pins: a resumed sweep seeds its `itemsDone` counter with the
// resume cursor (the items synced in a PREVIOUS session) but measures elapsed
// time only for the CURRENT session. Dividing already-synced + newly-fetched by
// this-session elapsed inflates the rate enormously, which made the sync-wizard
// ETA collapse to ~0s when half the library was already synced. The rate must
// be computed over NEW work only (itemsDone - resumeBaseline).

import { describe, expect, it } from 'vitest';

import { sweepItemsPerSec } from './sweep';

describe('sweepItemsPerSec', () => {
    it('counts only work done since the resume baseline', () => {
        // Resumed at 1000, fetched 500 more in 5s → 100/s, NOT 1500/5 = 300/s.
        expect(sweepItemsPerSec(1500, 1000, 5)).toBe(100);
    });

    it('equals total/elapsed for a fresh (non-resumed) sweep', () => {
        expect(sweepItemsPerSec(500, 0, 5)).toBe(100);
    });

    it('returns 0 for zero/negative elapsed (avoids divide-by-zero / Infinity)', () => {
        expect(sweepItemsPerSec(1200, 1000, 0)).toBe(0);
    });

    it('returns 0 when no new work has happened since resume', () => {
        expect(sweepItemsPerSec(1000, 1000, 5)).toBe(0);
    });
});
