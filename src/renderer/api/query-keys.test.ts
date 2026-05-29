// Pure-function tests for splitPaginatedQuery, which separates the pagination
// fields (limit / startIndex) from the remaining filter fields when building
// react-query cache keys. The filter/pagination split governs cache-key
// stability across paginated list fetches.

import { describe, expect, it } from 'vitest';

import { splitPaginatedQuery } from '/@/renderer/api/query-keys';

describe('splitPaginatedQuery', () => {
    it('returns an empty filter and undefined pagination for null input', () => {
        expect(splitPaginatedQuery(null)).toEqual({ filter: {}, pagination: undefined });
    });

    it('returns an empty filter and undefined pagination for undefined input', () => {
        expect(splitPaginatedQuery(undefined)).toEqual({ filter: {}, pagination: undefined });
    });

    it('returns undefined pagination when neither limit nor startIndex is present', () => {
        expect(splitPaginatedQuery({ sortBy: 'name' })).toEqual({
            filter: { sortBy: 'name' },
            pagination: undefined,
        });
    });

    it('splits out pagination when limit is present', () => {
        expect(splitPaginatedQuery({ limit: 50, sortBy: 'name' })).toEqual({
            filter: { sortBy: 'name' },
            pagination: { limit: 50, startIndex: undefined },
        });
    });

    it('splits out pagination when startIndex is present', () => {
        expect(splitPaginatedQuery({ sortBy: 'name', startIndex: 100 })).toEqual({
            filter: { sortBy: 'name' },
            pagination: { limit: undefined, startIndex: 100 },
        });
    });

    it('splits out both pagination fields when present', () => {
        expect(splitPaginatedQuery({ limit: 25, sortBy: 'name', startIndex: 75 })).toEqual({
            filter: { sortBy: 'name' },
            pagination: { limit: 25, startIndex: 75 },
        });
    });

    it('does not mutate the input query object', () => {
        const query = { limit: 10, sortBy: 'name', startIndex: 0 };
        splitPaginatedQuery(query);
        expect(query).toEqual({ limit: 10, sortBy: 'name', startIndex: 0 });
    });
});
