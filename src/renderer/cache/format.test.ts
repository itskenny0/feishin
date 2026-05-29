// Pure-function tests for the SI byte / count formatters used by the
// cache-sync progress UI. These pin the documented threshold rules:
//
//  - SI decimal scaling (1 KB = 1000 bytes, not 1024).
//  - One decimal place while the leading number is < 100, none at >= 100.
//  - Plain bytes below 1 KB, "—" for undefined / non-finite / negative.

import { describe, expect, it } from 'vitest';

import { formatBytes, formatCount } from '/@/renderer/cache/format';

describe('formatBytes', () => {
    it('returns the em-dash placeholder for undefined / non-finite / negative', () => {
        expect(formatBytes(undefined)).toBe('—');
        expect(formatBytes(Number.NaN)).toBe('—');
        expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
        expect(formatBytes(-1)).toBe('—');
    });

    it('renders raw bytes (rounded) below 1 KB', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(412)).toBe('412 B');
        expect(formatBytes(999)).toBe('999 B');
        // 999.4 rounds down to 999 and stays in the bytes branch.
        expect(formatBytes(999.4)).toBe('999 B');
    });

    it('scales by 1000, not 1024 (SI decimal units)', () => {
        expect(formatBytes(1000)).toBe('1.0 KB');
        expect(formatBytes(1_000_000)).toBe('1.0 MB');
        expect(formatBytes(1_000_000_000)).toBe('1.0 GB');
        expect(formatBytes(1_000_000_000_000)).toBe('1.0 TB');
    });

    it('shows one decimal place while the leading number is < 100', () => {
        expect(formatBytes(12_300)).toBe('12.3 KB');
        expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
    });

    it('drops decimals once the leading number reaches 100', () => {
        expect(formatBytes(856_000)).toBe('856 KB');
        // Just under the boundary keeps one decimal place.
        expect(formatBytes(99_500)).toBe('99.5 KB');
        // Exactly at the boundary drops decimals.
        expect(formatBytes(100_000)).toBe('100 KB');
    });

    it('caps at the largest unit (TB) for very large values', () => {
        expect(formatBytes(5_000_000_000_000)).toBe('5.0 TB');
        expect(formatBytes(1_500_000_000_000_000)).toBe('1500 TB');
    });
});

describe('formatCount', () => {
    it('returns the em-dash placeholder for undefined / non-finite', () => {
        expect(formatCount(undefined)).toBe('—');
        expect(formatCount(Number.NaN)).toBe('—');
        expect(formatCount(Number.POSITIVE_INFINITY)).toBe('—');
    });

    it('rounds to an integer before formatting', () => {
        expect(formatCount(0)).toBe('0');
        expect(formatCount(7)).toBe('7');
        expect(formatCount(7.6)).toBe('8');
    });

    it('groups thousands using the active locale', () => {
        // Assert via the same toLocaleString the formatter uses so the test
        // is locale-agnostic across CI environments.
        expect(formatCount(1234567)).toBe((1234567).toLocaleString());
    });
});
