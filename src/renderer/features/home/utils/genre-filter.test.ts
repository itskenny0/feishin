import { describe, expect, it } from 'vitest';

import { isCleanGenreName } from '/@/renderer/features/home/utils/genre-filter';

describe('isCleanGenreName', () => {
    it('accepts ordinary genre names', () => {
        expect(isCleanGenreName('Rock')).toBe(true);
        expect(isCleanGenreName('Hip Hop')).toBe(true);
        expect(isCleanGenreName('Drum & Bass')).toBe(true);
        expect(isCleanGenreName('R&B')).toBe(true);
    });

    it('rejects empty / whitespace-only names', () => {
        expect(isCleanGenreName('')).toBe(false);
        expect(isCleanGenreName('   ')).toBe(false);
    });

    it('rejects names longer than 40 characters', () => {
        expect(isCleanGenreName('a'.repeat(41))).toBe(false);
        // exactly 40 is allowed
        expect(isCleanGenreName('a'.repeat(40))).toBe(true);
    });

    it('rejects semicolon-separated multi-tag concatenations', () => {
        expect(isCleanGenreName('rap;50 Cent;Gangsta')).toBe(false);
    });

    it('rejects colon-separated category patterns', () => {
        expect(isCleanGenreName('Category: Subcategory')).toBe(false);
    });

    it('rejects names with four or more commas', () => {
        expect(isCleanGenreName('a,b,c,d,e')).toBe(false);
        // three commas is still allowed (and stays letter-majority)
        expect(isCleanGenreName('a,b,c,d')).toBe(true);
    });

    it('rejects names with three or more consecutive digits', () => {
        expect(isCleanGenreName('808')).toBe(false);
        expect(isCleanGenreName('Track 12345')).toBe(false);
    });

    it('accepts recognised decade labels despite their digits', () => {
        expect(isCleanGenreName('90s')).toBe(true);
        expect(isCleanGenreName('2000s')).toBe(true);
        expect(isCleanGenreName('2010s')).toBe(true);
    });

    it('rejects symbol-heavy junk where letters are a minority', () => {
        // 1 letter out of 4 chars -> 1*2 < 4 -> rejected
        expect(isCleanGenreName('// d')).toBe(false);
    });

    it('accepts a name where letters make up at least half the string', () => {
        // "ok!!" -> 2 letters of 4 chars -> 2*2 >= 4 -> allowed
        expect(isCleanGenreName('ok!!')).toBe(true);
        // "o!!!" -> 1 letter of 4 chars -> 1*2 < 4 -> rejected
        expect(isCleanGenreName('o!!!')).toBe(false);
    });

    it('trims surrounding whitespace before evaluating', () => {
        expect(isCleanGenreName('  Jazz  ')).toBe(true);
    });
});
