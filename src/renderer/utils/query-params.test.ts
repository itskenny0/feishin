import { describe, expect, it } from 'vitest';

import {
    getFilterQueryStringFromSearchParams,
    parseArrayParam,
    parseBooleanParam,
    parseIntParam,
    parseJsonParam,
    parseStringParam,
    setJsonSearchParam,
    setMultipleSearchParams,
    setSearchParam,
} from './query-params';

describe('parseArrayParam', () => {
    it('returns all values for a repeated key', () => {
        const params = new URLSearchParams('genre=rock&genre=pop');
        expect(parseArrayParam(params, 'genre')).toEqual(['rock', 'pop']);
    });

    it('returns undefined when the key is absent', () => {
        expect(parseArrayParam(new URLSearchParams(''), 'genre')).toBeUndefined();
    });
});

describe('parseBooleanParam', () => {
    it('parses the string "true" as true', () => {
        expect(parseBooleanParam(new URLSearchParams('x=true'), 'x')).toBe(true);
    });

    it('parses any other value as false', () => {
        expect(parseBooleanParam(new URLSearchParams('x=false'), 'x')).toBe(false);
        expect(parseBooleanParam(new URLSearchParams('x=1'), 'x')).toBe(false);
    });

    it('returns undefined when the key is absent', () => {
        expect(parseBooleanParam(new URLSearchParams(''), 'x')).toBeUndefined();
    });
});

describe('parseIntParam', () => {
    it('parses a valid integer', () => {
        expect(parseIntParam(new URLSearchParams('page=12'), 'page')).toBe(12);
    });

    it('returns undefined for a non-numeric value', () => {
        expect(parseIntParam(new URLSearchParams('page=abc'), 'page')).toBeUndefined();
    });

    it('returns undefined when the key is absent', () => {
        expect(parseIntParam(new URLSearchParams(''), 'page')).toBeUndefined();
    });
});

describe('parseStringParam', () => {
    it('returns the raw string value', () => {
        expect(parseStringParam(new URLSearchParams('q=hello'), 'q')).toBe('hello');
    });

    it('returns undefined when the key is absent', () => {
        expect(parseStringParam(new URLSearchParams(''), 'q')).toBeUndefined();
    });
});

describe('parseJsonParam', () => {
    it('parses valid JSON', () => {
        const params = new URLSearchParams();
        params.set('f', JSON.stringify({ a: 1, b: [2, 3] }));
        expect(parseJsonParam(params, 'f')).toEqual({ a: 1, b: [2, 3] });
    });

    it('returns undefined for invalid JSON', () => {
        expect(parseJsonParam(new URLSearchParams('f=not-json'), 'f')).toBeUndefined();
    });

    it('returns undefined when the key is absent', () => {
        expect(parseJsonParam(new URLSearchParams(''), 'f')).toBeUndefined();
    });
});

describe('setSearchParam', () => {
    it('removes the key for null or undefined', () => {
        const base = new URLSearchParams('a=1');
        expect(setSearchParam(base, 'a', null).has('a')).toBe(false);
        expect(setSearchParam(base, 'a', undefined).has('a')).toBe(false);
    });

    it('does not mutate the original params', () => {
        const base = new URLSearchParams('a=1');
        setSearchParam(base, 'a', 2);
        expect(base.get('a')).toBe('1');
    });

    it('sets a boolean as its string form', () => {
        expect(setSearchParam(new URLSearchParams(), 'flag', true).get('flag')).toBe('true');
    });

    it('sets a number as its string form', () => {
        expect(setSearchParam(new URLSearchParams(), 'n', 42).get('n')).toBe('42');
    });

    it('appends each element of an array', () => {
        const result = setSearchParam(new URLSearchParams(), 'g', ['rock', 'pop']);
        expect(result.getAll('g')).toEqual(['rock', 'pop']);
    });

    it('replaces existing array entries rather than appending to them', () => {
        const base = new URLSearchParams('g=old');
        const result = setSearchParam(base, 'g', ['new']);
        expect(result.getAll('g')).toEqual(['new']);
    });
});

describe('setJsonSearchParam', () => {
    it('serialises an object to JSON', () => {
        const result = setJsonSearchParam(new URLSearchParams(), 'f', { a: 1 });
        expect(result.get('f')).toBe('{"a":1}');
    });

    it('removes the key for null', () => {
        const base = new URLSearchParams('f=%7B%7D');
        expect(setJsonSearchParam(base, 'f', null).has('f')).toBe(false);
    });
});

describe('setMultipleSearchParams', () => {
    it('applies a mix of value kinds in one pass', () => {
        const result = setMultipleSearchParams(new URLSearchParams(), {
            absent: undefined,
            count: 5,
            enabled: true,
            tags: ['a', 'b'],
        });
        expect(result.get('count')).toBe('5');
        expect(result.get('enabled')).toBe('true');
        expect(result.getAll('tags')).toEqual(['a', 'b']);
        expect(result.has('absent')).toBe(false);
    });

    it('JSON-encodes keys listed in jsonKeys', () => {
        const result = setMultipleSearchParams(
            new URLSearchParams(),
            { filters: { genre: 'rock' } },
            new Set(['filters']),
        );
        expect(result.get('filters')).toBe('{"genre":"rock"}');
    });

    it('drops a jsonKey whose value is an array', () => {
        const result = setMultipleSearchParams(
            new URLSearchParams('filters=stale'),
            { filters: ['a'] },
            new Set(['filters']),
        );
        expect(result.has('filters')).toBe(false);
    });
});

describe('getFilterQueryStringFromSearchParams', () => {
    it('strips pagination and scroll keys', () => {
        const params = new URLSearchParams('q=rock&currentPage=2&scrollOffset=100');
        const result = getFilterQueryStringFromSearchParams(params);
        const parsed = new URLSearchParams(result);
        expect(parsed.get('q')).toBe('rock');
        expect(parsed.has('currentPage')).toBe(false);
        expect(parsed.has('scrollOffset')).toBe(false);
    });

    it('merges custom filters into the query string', () => {
        const params = new URLSearchParams('q=rock');
        const result = getFilterQueryStringFromSearchParams(params, {
            favorite: true,
            tags: ['a', 'b'],
        });
        const parsed = new URLSearchParams(result);
        expect(parsed.get('favorite')).toBe('true');
        expect(parsed.getAll('tags')).toEqual(['a', 'b']);
    });

    it('JSON-encodes nested object custom filters', () => {
        const result = getFilterQueryStringFromSearchParams(new URLSearchParams(), {
            range: { from: 1, to: 2 },
        });
        const parsed = new URLSearchParams(result);
        expect(parsed.get('range')).toBe('{"from":1,"to":2}');
    });

    it('skips null and undefined custom filter values', () => {
        const result = getFilterQueryStringFromSearchParams(new URLSearchParams(), {
            present: 'yes',
        });
        const parsed = new URLSearchParams(result);
        expect(parsed.get('present')).toBe('yes');
    });
});
