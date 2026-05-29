// Regression tests for the renderer-side row + sorted-result memo.
//
// The memo sits in front of `db.albums.toArray()` and friends so the
// album / artist / song grids don't replay a 50k-row structured-clone
// per scroll page. These tests assert:
//
//  1. `loadEntityRows` calls the loader once per entity, then serves the
//     same array reference until `markRowCacheDirty` fires.
//  2. `markRowCacheDirty('albums')` drops the JS-heap copy AND the sorted
//     LRU for that entity, but leaves the other entities intact.
//  3. `markRowCacheDirty('all')` clears every entity.
//  4. `getOrComputeSorted` caches by signature and serves repeat callers
//     from memory without re-invoking the compute function.
//  5. `buildListSignature` strips `startIndex` + `limit` so every page of
//     the same scroll lands on the same memo entry.

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedAlbum } from '/@/renderer/cache/types';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildListSignature,
    debugLocalCache,
    getOrComputeSorted,
    loadEntityRows,
    markRowCacheDirty,
    resetRowCache,
} from '/@/renderer/cache/local-cache';

afterEach(() => {
    resetRowCache();
    vi.clearAllMocks();
});

const fakeRow = (id: string): CachedAlbum =>
    ({
        __cachedAt: 0,
        AlbumArtistId: 'a',
        DateLastSaved: '',
        GenreIds: [],
        Id: id,
        Payload: { id, name: id } as never,
        ProductionYear: undefined,
        SortName: id,
    }) satisfies CachedAlbum;

// loadEntityRows takes a LibraryCacheDb but only forwards it to the
// loader callback — these tests pass a sentinel that the loader ignores.
const FAKE_DB = {} as unknown as LibraryCacheDb;

describe('local-cache row layer', () => {
    it('loads rows once then serves the same reference', async () => {
        const loader = vi.fn(async () => [fakeRow('a'), fakeRow('b')]);

        const first = await loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader);
        const second = await loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(second).toBe(first);
        expect(debugLocalCache().rows.albums.count).toBe(2);
    });

    it('coalesces concurrent loads into a single loader call', async () => {
        const loader = vi.fn(async () => {
            // Yield so both callers register before we resolve.
            await Promise.resolve();
            return [fakeRow('a')];
        });

        const [a, b] = await Promise.all([
            loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader),
            loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader),
        ]);

        expect(loader).toHaveBeenCalledTimes(1);
        expect(a).toBe(b);
    });

    it('drops the per-entity row cache on markRowCacheDirty', async () => {
        const loader = vi.fn(async () => [fakeRow('a')]);

        await loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader);
        markRowCacheDirty('albums');
        await loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader);

        expect(loader).toHaveBeenCalledTimes(2);
    });

    it('leaves other entities intact when only one is marked dirty', async () => {
        const albumsLoader = vi.fn(async () => [fakeRow('a')]);
        const songsLoader = vi.fn(async () => [fakeRow('s')]);

        await loadEntityRows('albums', FAKE_DB, albumsLoader);
        await loadEntityRows('songs', FAKE_DB, songsLoader);

        markRowCacheDirty('albums');

        await loadEntityRows('albums', FAKE_DB, albumsLoader);
        await loadEntityRows('songs', FAKE_DB, songsLoader);

        expect(albumsLoader).toHaveBeenCalledTimes(2);
        expect(songsLoader).toHaveBeenCalledTimes(1);
    });

    it('drops every entity on markRowCacheDirty("all")', async () => {
        const albumsLoader = vi.fn(async () => [fakeRow('a')]);
        const songsLoader = vi.fn(async () => [fakeRow('s')]);

        await loadEntityRows('albums', FAKE_DB, albumsLoader);
        await loadEntityRows('songs', FAKE_DB, songsLoader);

        markRowCacheDirty('all');

        await loadEntityRows('albums', FAKE_DB, albumsLoader);
        await loadEntityRows('songs', FAKE_DB, songsLoader);

        expect(albumsLoader).toHaveBeenCalledTimes(2);
        expect(songsLoader).toHaveBeenCalledTimes(2);
    });

    it('retries from the loader after a thrown rejection', async () => {
        const loader = vi
            .fn()
            .mockRejectedValueOnce(new Error('idb closed'))
            .mockResolvedValueOnce([fakeRow('a')]);

        await expect(loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader)).rejects.toThrow(
            'idb closed',
        );
        // After the failure the cache must NOT hold an in-flight promise
        // (otherwise every subsequent caller would see the same rejection).
        expect(debugLocalCache().rows.albums.inFlight).toBe(false);

        const rows = await loadEntityRows<CachedAlbum>('albums', FAKE_DB, loader);
        expect(rows).toHaveLength(1);
        expect(loader).toHaveBeenCalledTimes(2);
    });
});

describe('local-cache sorted layer', () => {
    it('serves the cached sorted list for a repeat signature', async () => {
        const compute = vi.fn(async () => ['a', 'b', 'c']);

        const a = await getOrComputeSorted('albums', 'sig-1', compute);
        const b = await getOrComputeSorted('albums', 'sig-1', compute);

        expect(compute).toHaveBeenCalledTimes(1);
        expect(b).toBe(a);
    });

    it('stores per-signature so two distinct queries coexist', async () => {
        const compute1 = vi.fn(async () => ['a']);
        const compute2 = vi.fn(async () => ['x', 'y']);

        await getOrComputeSorted('albums', 'sig-1', compute1);
        await getOrComputeSorted('albums', 'sig-2', compute2);

        // Re-query both — should both hit cache.
        await getOrComputeSorted('albums', 'sig-1', compute1);
        await getOrComputeSorted('albums', 'sig-2', compute2);

        expect(compute1).toHaveBeenCalledTimes(1);
        expect(compute2).toHaveBeenCalledTimes(1);
    });

    it('drops the sorted LRU when the row cache is marked dirty', async () => {
        const compute = vi.fn(async () => ['a']);

        await getOrComputeSorted('albums', 'sig-1', compute);
        markRowCacheDirty('albums');
        await getOrComputeSorted('albums', 'sig-1', compute);

        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('evicts the oldest LRU entry past the cap', async () => {
        // The module caps at 6 entries per entity. Inserting 8 distinct
        // signatures must leave the two oldest evicted.
        for (let i = 0; i < 8; i += 1) {
            await getOrComputeSorted('albums', `sig-${i}`, async () => [i]);
        }
        const signatures = debugLocalCache().sorted.albums.signatures;
        expect(signatures).toHaveLength(6);
        expect(signatures).toContain('sig-7');
        expect(signatures).not.toContain('sig-0');
        expect(signatures).not.toContain('sig-1');
    });

    it('promotes a touched signature to the MRU position', async () => {
        for (let i = 0; i < 6; i += 1) {
            await getOrComputeSorted('albums', `sig-${i}`, async () => [i]);
        }
        // Touch sig-0 — it should now be MRU.
        await getOrComputeSorted('albums', 'sig-0', async () => [99]);

        // Add a new entry; if sig-0 weren't promoted it would be the
        // first to evict. Instead sig-1 should fall off.
        await getOrComputeSorted('albums', 'sig-new', async () => ['new']);
        const sigs = debugLocalCache().sorted.albums.signatures;
        expect(sigs).toContain('sig-0');
        expect(sigs).not.toContain('sig-1');
    });

    it('returns undefined and skips storage when compute returns undefined', async () => {
        const compute = vi.fn(async () => undefined);
        const result = await getOrComputeSorted('albums', 'sig-empty', compute);
        expect(result).toBeUndefined();
        // Repeat call must re-invoke compute (no cached "undefined" entry).
        await getOrComputeSorted('albums', 'sig-empty', compute);
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('caches an empty array as a hit (the favourites-poisoning trap)', async () => {
        // This documents the foot-gun behind the sidebar "Favourite albums"
        // regression: `getOrComputeSorted` treats `[]` as a legitimate result
        // and memoises it. Once stored, the compute is never re-run for that
        // signature until markRowCacheDirty fires. A `favorite:true` compute
        // that ran while `db.favorites` was still empty would therefore pin an
        // empty list under the favourite-filter signature forever.
        const compute = vi.fn(async () => [] as string[]);
        const first = await getOrComputeSorted('albums', 'sig-fav-empty', compute);
        const second = await getOrComputeSorted('albums', 'sig-fav-empty', compute);
        expect(first).toEqual([]);
        expect(second).toBe(first);
        expect(compute).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// Regression: sidebar "Favourite albums" stays empty after a cold start.
//
// Reproduces the exact memo-poisoning failure and proves the album-api
// fromCache fix. The compute below mirrors albumQueries.list's fromCache
// favourite branch WITHOUT a live Dexie (we drive the favourites set
// directly): when `favorite:true` is requested and the favourites set is
// empty, the FIXED compute returns `undefined` (cache miss → remote
// fallback) instead of an empty list. The buggy compute returned the empty
// list, which getOrComputeSorted memoised, so even after favourites synced
// the sidebar kept serving the stale empty memo.
// ---------------------------------------------------------------------------
describe('favourite-albums fromCache contract (sidebar regression)', () => {
    // Stand-in for the favourites cache + albums table the album-api compute
    // reads. Mutating `favoriteIds` between calls simulates the favourites
    // sweep landing AFTER the first (cold) read.
    const makeFavouriteCompute = (
        favoriteIds: () => Set<string>,
        albumIds: string[],
        opts: { fixed: boolean },
    ) =>
        vi.fn(async (): Promise<string[] | undefined> => {
            if (albumIds.length === 0) return undefined; // albums table empty
            const favs = favoriteIds();
            // FIXED behaviour: a favourite:true filter with no cached
            // favourites is a cache MISS so cachedSwr falls back to remote.
            if (opts.fixed && favs.size === 0) return undefined;
            // filterAlbumsLocal(favorite:true) over an empty set yields [].
            return albumIds.filter((id) => favs.has(id));
        });

    it('BUGGY: memoises the empty list and never recovers after favourites sync', async () => {
        const favs = new Set<string>();
        const compute = makeFavouriteCompute(() => favs, ['alb-1', 'alb-2'], { fixed: false });
        const sig = 'albums:list:all:{"favorite":true,"sortBy":"name"}';

        // Cold read — favourites not yet synced.
        const cold = await getOrComputeSorted('albums', sig, compute);
        expect(cold).toEqual([]); // empty list served

        // Favourites sweep lands.
        favs.add('alb-1');
        favs.add('alb-2');

        // Without invalidation the poisoned empty memo is still served and
        // compute is NOT re-run — this is the user-visible regression.
        const warm = await getOrComputeSorted('albums', sig, compute);
        expect(warm).toEqual([]);
        expect(compute).toHaveBeenCalledTimes(1);
    });

    it('FIXED: empty favourites is a miss, so the populated list appears once synced', async () => {
        const favs = new Set<string>();
        const compute = makeFavouriteCompute(() => favs, ['alb-1', 'alb-2'], { fixed: true });
        const sig = 'albums:list:all:{"favorite":true,"sortBy":"name"}';

        // Cold read — favourites not yet synced → MISS (compute returns
        // undefined), so nothing is memoised and cachedSwr would hit remote.
        const cold = await getOrComputeSorted('albums', sig, compute);
        expect(cold).toBeUndefined();

        // Favourites sweep lands.
        favs.add('alb-1');
        favs.add('alb-2');

        // Next read recomputes (no poisoned entry) and serves the favourites.
        const warm = await getOrComputeSorted('albums', sig, compute);
        expect(warm).toEqual(['alb-1', 'alb-2']);
        expect(compute).toHaveBeenCalledTimes(2);
    });

    it('FIXED: the markRowCacheDirty path also clears a stale empty memo', async () => {
        // Defence-in-depth: even if an empty list WAS memoised (e.g. a non-
        // favourite query path), the favourites sweep now calls
        // markSearchDirty('albums') → markRowCacheDirty('albums'), dropping
        // the sorted LRU so the next read recomputes.
        const favs = new Set<string>();
        const compute = makeFavouriteCompute(() => favs, ['alb-1'], { fixed: false });
        const sig = 'albums:list:all:{"favorite":true,"sortBy":"name"}';

        await getOrComputeSorted('albums', sig, compute); // memoises []
        favs.add('alb-1');
        markRowCacheDirty('albums'); // what the favourites sweep now triggers

        const after = await getOrComputeSorted('albums', sig, compute);
        expect(after).toEqual(['alb-1']);
        expect(compute).toHaveBeenCalledTimes(2);
    });
});

describe('buildListSignature', () => {
    it('strips startIndex and limit so pagination shares the entry', () => {
        const a = buildListSignature('albums', { limit: 50, sortBy: 'name', startIndex: 0 });
        const b = buildListSignature('albums', { limit: 50, sortBy: 'name', startIndex: 50 });
        const c = buildListSignature('albums', { limit: 100, sortBy: 'name', startIndex: 50 });
        expect(a).toBe(b);
        expect(a).toBe(c);
    });

    it('drops undefined fields so a query with explicit undefined matches an omitted one', () => {
        const a = buildListSignature('albums', { sortBy: 'name' });
        const b = buildListSignature('albums', { favorite: undefined, sortBy: 'name' });
        expect(a).toBe(b);
    });

    it('keeps the entity label so identical queries on different entities do not collide', () => {
        const albums = buildListSignature('albums', { sortBy: 'name' });
        const songs = buildListSignature('songs', { sortBy: 'name' });
        expect(albums).not.toBe(songs);
    });

    it('differs when a meaningful filter changes', () => {
        const a = buildListSignature('albums', { sortBy: 'name' });
        const b = buildListSignature('albums', { searchTerm: 'beatles', sortBy: 'name' });
        expect(a).not.toBe(b);
    });
});
