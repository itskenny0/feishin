import { afterEach, describe, expect, it, vi } from 'vitest';

import { shuffle, shuffleInPlace } from './shuffle';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('shuffle', () => {
    it('does not mutate the input array', () => {
        const input = [1, 2, 3, 4, 5];
        const copy = [...input];
        shuffle(input);
        expect(input).toEqual(copy);
    });

    it('returns a new array reference', () => {
        const input = [1, 2, 3];
        expect(shuffle(input)).not.toBe(input);
    });

    it('preserves all elements (is a permutation)', () => {
        const input = [1, 2, 3, 4, 5, 6, 7, 8];
        const result = shuffle(input);
        expect([...result].sort((a, b) => a - b)).toEqual(input);
    });

    it('handles empty and single-element arrays', () => {
        expect(shuffle([])).toEqual([]);
        expect(shuffle([42])).toEqual([42]);
    });

    it('produces a deterministic result for a fixed random sequence', () => {
        // Math.random() === 0 forces j = floor(0 * (i+1)) = 0 for every swap,
        // so each element from the end is swapped with index 0 in turn.
        vi.spyOn(Math, 'random').mockReturnValue(0);
        expect(shuffle([1, 2, 3])).toEqual([2, 3, 1]);
    });
});

describe('shuffleInPlace', () => {
    it('mutates and returns the same array reference', () => {
        const input = [1, 2, 3];
        const result = shuffleInPlace(input);
        expect(result).toBe(input);
    });

    it('preserves all elements (is a permutation)', () => {
        const input = [1, 2, 3, 4, 5];
        const expected = [...input];
        shuffleInPlace(input);
        expect([...input].sort((a, b) => a - b)).toEqual(expected);
    });

    it('handles empty and single-element arrays', () => {
        expect(shuffleInPlace([])).toEqual([]);
        expect(shuffleInPlace([7])).toEqual([7]);
    });
});
