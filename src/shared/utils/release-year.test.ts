import { describe, expect, it } from 'vitest';

import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

describe('isPlausibleReleaseYear', () => {
    it('accepts four-digit years within the plausible range', () => {
        expect(isPlausibleReleaseYear(1000)).toBe(true);
        expect(isPlausibleReleaseYear(1984)).toBe(true);
        expect(isPlausibleReleaseYear(2026)).toBe(true);
        expect(isPlausibleReleaseYear(9999)).toBe(true);
    });

    it('rejects the implausible default/sentinel values', () => {
        expect(isPlausibleReleaseYear(0)).toBe(false);
        expect(isPlausibleReleaseYear(1)).toBe(false);
        expect(isPlausibleReleaseYear(999)).toBe(false);
        expect(isPlausibleReleaseYear(10000)).toBe(false);
    });

    it('rejects nullish values', () => {
        expect(isPlausibleReleaseYear(null)).toBe(false);
        expect(isPlausibleReleaseYear(undefined)).toBe(false);
    });

    it('rejects non-integer numbers', () => {
        expect(isPlausibleReleaseYear(1984.5)).toBe(false);
        expect(isPlausibleReleaseYear(Number.NaN)).toBe(false);
        expect(isPlausibleReleaseYear(Number.POSITIVE_INFINITY)).toBe(false);
    });
});
