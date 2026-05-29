import { describe, expect, it } from 'vitest';

import { parseSearchParams } from './parse-search-params';

describe('parseSearchParams', () => {
    it('serialises scalar values', () => {
        const result = new URLSearchParams(parseSearchParams({ page: 2, q: 'rock' }));
        expect(result.get('q')).toBe('rock');
        expect(result.get('page')).toBe('2');
    });

    it('omits undefined values', () => {
        const result = new URLSearchParams(parseSearchParams({ a: 1, b: undefined }));
        expect(result.has('a')).toBe(true);
        expect(result.has('b')).toBe(false);
    });

    it('appends each element of an array under the same key', () => {
        const result = new URLSearchParams(parseSearchParams({ genre: ['rock', 'pop'] }));
        expect(result.getAll('genre')).toEqual(['rock', 'pop']);
    });

    it('coerces booleans and numbers to strings', () => {
        const result = new URLSearchParams(parseSearchParams({ flag: true, n: 0 }));
        expect(result.get('flag')).toBe('true');
        expect(result.get('n')).toBe('0');
    });

    it('returns an empty string for an empty object', () => {
        expect(parseSearchParams({})).toBe('');
    });
});
