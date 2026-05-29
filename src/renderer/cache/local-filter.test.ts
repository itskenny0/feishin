// Pure-function contract tests for filterAlbumsLocal's favourite branch.
//
// These pin the exact behaviours the album-api fromCache guard relies on:
//
//  - `favorite: true` with NO favourite-ids Set provided → undefined
//    (the caller hasn't loaded favourites; fall back to the network).
//  - `favorite: true` with an EMPTY favourite-ids Set → an empty *response*
//    ({ items: [], totalRecordCount: 0 }), NOT undefined. This is the trap
//    behind the sidebar "Favourite albums" regression: the cache layer
//    above memoised that empty response under the favourite-filter
//    signature and served it as a hit, suppressing the remote fallback even
//    after the favourites sweep populated the table.
//  - `favorite: true` with a populated Set → only the favourited rows.

import type { CachedAlbum } from '/@/renderer/cache/types';

import { describe, expect, it } from 'vitest';

import { filterAlbumsLocal } from '/@/renderer/cache/local-filter';
import { AlbumListSort, SortOrder } from '/@/shared/types/domain-types';

const album = (id: string, name = id): CachedAlbum =>
    ({
        __cachedAt: 0,
        AlbumArtistId: 'artist-1',
        DateLastSaved: '',
        GenreIds: [],
        Id: id,
        Payload: { id, name } as never,
        ProductionYear: undefined,
        SortName: name,
    }) satisfies CachedAlbum;

const favouriteQuery = {
    favorite: true as const,
    sortBy: AlbumListSort.NAME,
    sortOrder: SortOrder.ASC,
    startIndex: 0,
};

describe('filterAlbumsLocal favourite branch', () => {
    const rows = [album('a'), album('b'), album('c')];

    it('returns undefined when favourites are required but no Set is supplied', () => {
        const out = filterAlbumsLocal({ query: favouriteQuery, rows });
        expect(out).toBeUndefined();
    });

    it('returns an EMPTY response (not undefined) when the favourites Set is empty', () => {
        // This is the load-bearing behaviour: an empty Set is "favourites are
        // known and there are none" as far as the pure filter is concerned,
        // so it yields a real (empty) response. The caching layer must NOT
        // treat this as a durable cache hit during a cold start, which is why
        // album-api now short-circuits to a miss when favorite:true and the
        // set is empty.
        const out = filterAlbumsLocal({
            favoriteAlbumIds: new Set<string>(),
            query: favouriteQuery,
            rows,
        });
        expect(out).toBeDefined();
        expect(out?.items).toEqual([]);
        expect(out?.totalRecordCount).toBe(0);
    });

    it('returns only the favourited rows when the Set is populated', () => {
        const out = filterAlbumsLocal({
            favoriteAlbumIds: new Set(['a', 'c']),
            query: favouriteQuery,
            rows,
        });
        expect(out?.items.map((i) => i.id)).toEqual(['a', 'c']);
        expect(out?.totalRecordCount).toBe(2);
    });
});
