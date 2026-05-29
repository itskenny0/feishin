// Pure-function tests for the partial-ISO date parsing helpers. These pin the
// accepted shapes (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`), the rejection of malformed
// input, and the full-datetime prefix fallback used when reading API payloads.

import { describe, expect, it } from 'vitest';

import {
    coerceYear,
    parsePartialIsoDate,
    parsePartialIsoDateFromApi,
} from '/@/shared/api/partial-iso-date';

describe('coerceYear', () => {
    it('returns finite numbers unchanged', () => {
        expect(coerceYear(1999)).toBe(1999);
        expect(coerceYear(0)).toBe(0);
        expect(coerceYear(-5)).toBe(-5);
    });

    it('returns 0 for null and undefined', () => {
        expect(coerceYear(null)).toBe(0);
        expect(coerceYear(undefined)).toBe(0);
    });

    it('returns 0 for non-finite numbers', () => {
        expect(coerceYear(NaN)).toBe(0);
        expect(coerceYear(Infinity)).toBe(0);
        expect(coerceYear(-Infinity)).toBe(0);
    });
});

describe('parsePartialIsoDate', () => {
    it('parses a bare year', () => {
        expect(parsePartialIsoDate('2021')).toEqual({ date: '2021', year: 2021 });
    });

    it('parses year-month', () => {
        expect(parsePartialIsoDate('2021-07')).toEqual({ date: '2021-07', year: 2021 });
    });

    it('parses year-month-day', () => {
        expect(parsePartialIsoDate('2021-07-15')).toEqual({ date: '2021-07-15', year: 2021 });
    });

    it('trims surrounding whitespace', () => {
        expect(parsePartialIsoDate('  2021-07  ')).toEqual({ date: '2021-07', year: 2021 });
    });

    it('rejects null, undefined, and empty strings', () => {
        expect(parsePartialIsoDate(null)).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDate(undefined)).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDate('')).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDate('   ')).toEqual({ date: null, year: 0 });
    });

    it('rejects full datetime strings (handled only by the API variant)', () => {
        expect(parsePartialIsoDate('2021-07-15T00:00:00Z')).toEqual({ date: null, year: 0 });
    });

    it('rejects malformed values', () => {
        expect(parsePartialIsoDate('not-a-date')).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDate('21')).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDate('2021-7')).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDate('2021/07/15')).toEqual({ date: null, year: 0 });
    });
});

describe('parsePartialIsoDateFromApi', () => {
    it('delegates to parsePartialIsoDate for already-valid partial dates', () => {
        expect(parsePartialIsoDateFromApi('2021-07')).toEqual({ date: '2021-07', year: 2021 });
    });

    it('uses the YYYY-MM-DD prefix of a full ISO datetime', () => {
        expect(parsePartialIsoDateFromApi('2021-07-15T12:34:56Z')).toEqual({
            date: '2021-07-15',
            year: 2021,
        });
    });

    it('returns the empty result for null, undefined, and short junk', () => {
        expect(parsePartialIsoDateFromApi(null)).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDateFromApi(undefined)).toEqual({ date: null, year: 0 });
        expect(parsePartialIsoDateFromApi('nope')).toEqual({ date: null, year: 0 });
    });

    it('returns the empty result when the 10-char prefix is not a valid date', () => {
        expect(parsePartialIsoDateFromApi('15/07/2021 extra')).toEqual({ date: null, year: 0 });
    });
});
