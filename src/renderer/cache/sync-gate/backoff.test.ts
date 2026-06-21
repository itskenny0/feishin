import { describe, expect, it } from 'vitest';

import { backoffDelayMs, canContinueAnyway, ESCAPE_HATCH_AFTER_FAILURES } from './backoff';

describe('backoffDelayMs', () => {
    it('is zero before any failure', () => {
        expect(backoffDelayMs(0)).toBe(0);
        expect(backoffDelayMs(-1)).toBe(0);
    });

    it('grows exponentially from the base', () => {
        expect(backoffDelayMs(1)).toBe(3_000);
        expect(backoffDelayMs(2)).toBe(6_000);
        expect(backoffDelayMs(3)).toBe(12_000);
    });

    it('caps at the max', () => {
        expect(backoffDelayMs(20)).toBe(60_000);
    });
});

describe('canContinueAnyway', () => {
    it('is hidden before the threshold', () => {
        expect(canContinueAnyway(0)).toBe(false);
        expect(canContinueAnyway(ESCAPE_HATCH_AFTER_FAILURES - 1)).toBe(false);
    });

    it('appears at and after the threshold', () => {
        expect(canContinueAnyway(ESCAPE_HATCH_AFTER_FAILURES)).toBe(true);
        expect(canContinueAnyway(ESCAPE_HATCH_AFTER_FAILURES + 5)).toBe(true);
    });
});
