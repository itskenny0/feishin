// Regression tests for the cache-side fuzzy search projection.
//
// The Fuse indexes were rebuilt from a slim `{ name, artist, payload }`
// view of every row so the index footprint scales with the indexed
// strings, not the whole CachedRow (which holds artwork URLs, lyrics,
// genre arrays, etc). These tests assert:
//
//  1. A search hit returns the ORIGINAL Payload object the caller stored
//     — proves the projection didn't drop the reference.
//  2. Album / song matching covers both the `name` and the leading
//     album-artist `artist` field, with the configured weights still
//     letting the album-artist match score below a name match.
//  3. An empty query returns an empty result without touching the index.
//
// We don't drive Dexie here - instead we exercise the searchXLocal
// entry points through a mocked `getActiveCacheDb()` that
// returns a tiny in-memory table-shim.

import type { Album, AlbumArtist, Song } from '/@/shared/types/domain-types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    markSearchDirty,
    resetSearchIndexes,
    searchAlbumsLocal,
    searchArtistsLocal,
    searchSongsLocal,
} from '/@/renderer/cache/search';

// Mock the capability + DB helpers so search.ts thinks the cache is
// available and the index loaders can pull from our
// in-memory shim.
const ROWS = {
    albums: [
        {
            Id: 'al1',
            Payload: {
                albumArtists: [{ id: 'aa1', name: 'The Beatles' }],
                id: 'al1',
                name: 'Abbey Road',
            } as Album,
        },
        {
            Id: 'al2',
            Payload: {
                albumArtists: [{ id: 'aa2', name: 'Pink Floyd' }],
                id: 'al2',
                name: 'Dark Side of the Moon',
            } as Album,
        },
    ],
    artists: [
        {
            Id: 'aa1',
            Kind: 'AlbumArtist',
            Payload: { id: 'aa1', name: 'The Beatles' } as AlbumArtist,
        },
        {
            Id: 'aa2',
            Kind: 'AlbumArtist',
            Payload: { id: 'aa2', name: 'Pink Floyd' } as AlbumArtist,
        },
        // An Artist (song-artist) kind should be filtered out of the
        // album-artist index by the where('Kind') hop.
        { Id: 'a3', Kind: 'Artist', Payload: { id: 'a3', name: 'John Lennon' } as AlbumArtist },
    ],
    songs: [
        {
            Id: 's1',
            Payload: {
                albumArtists: [{ id: 'aa1', name: 'The Beatles' }],
                id: 's1',
                name: 'Come Together',
            } as Song,
        },
        {
            Id: 's2',
            Payload: {
                albumArtists: [{ id: 'aa2', name: 'Pink Floyd' }],
                id: 's2',
                name: 'Time',
            } as Song,
        },
    ],
};

// The chunked index build pages through `.offset(o).limit(l).toArray()`, so the
// shim exposes a chainable collection (offset/limit return a sliced collection)
// alongside the where('Kind').equals() hop the artist index uses.
interface CollectionShim<T> {
    limit: (l: number) => CollectionShim<T>;
    offset: (o: number) => CollectionShim<T>;
    toArray: () => Promise<T[]>;
}
const collectionShim = <T>(rows: T[]): CollectionShim<T> => ({
    limit: (l: number) => collectionShim(rows.slice(0, l)),
    offset: (o: number) => collectionShim(rows.slice(o)),
    toArray: async () => rows,
});
const tableShim = <T extends { Id: string }>(rows: T[]) => ({
    ...collectionShim(rows),
    bulkGet: async (ids: string[]) => ids.map((id) => rows.find((r) => r.Id === id)),
    where: (_k: string) => ({
        equals: (_v: string) =>
            collectionShim(
                rows.filter((r) => (r as { Kind?: string }).Kind === _v || _k !== 'Kind'),
            ),
    }),
});

vi.mock('/@/renderer/cache/capability', () => ({
    isCacheAvailable: async () => true,
    isCacheAvailableSync: () => true,
}));

// The real getActiveCacheDb returns the same Dexie handle until closeCacheDb,
// so the mock must also memoize. search.ts compares handles to detect a
// server switch mid-build; without memoisation every comparison fails and
// the index build always discards itself.
const mockDb = {
    albums: tableShim(ROWS.albums),
    artists: tableShim(ROWS.artists),
    songs: tableShim(ROWS.songs),
};
vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mockDb,
}));

beforeEach(() => {
    resetSearchIndexes();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('search projection', () => {
    it('returns the original Album Payload reference on a name hit', async () => {
        const results = await searchAlbumsLocal('Abbey Road');
        expect(results).toHaveLength(1);
        expect(results[0]).toBe(ROWS.albums[0].Payload);
    });

    it('matches an album by the leading album-artist name', async () => {
        const results = await searchAlbumsLocal('Pink Floyd');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].id).toBe('al2');
    });

    it('matches a song by either the song name or the artist name', async () => {
        const byName = await searchSongsLocal('Come Together');
        expect(byName[0]?.id).toBe('s1');

        const byArtist = await searchSongsLocal('Pink Floyd');
        expect(byArtist.find((s) => s.id === 's2')).toBeDefined();
    });

    it('only indexes AlbumArtist-kind rows for the artist search', async () => {
        const results = await searchArtistsLocal('John Lennon');
        // John Lennon is stored as Kind: 'Artist' (song-artist), so the
        // AlbumArtist index must not surface him.
        expect(results.find((a) => a.id === 'a3')).toBeUndefined();
    });

    it('returns an empty list for a blank query without touching the index', async () => {
        const spy = vi.spyOn(mockDb.albums, 'offset');
        expect(await searchAlbumsLocal('   ')).toEqual([]);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT drop the grid row cache (search-dirty is fuse-only)', async () => {
        const { debugLocalCache, loadEntityRows, resetRowCache } =
            await import('/@/renderer/cache/local-cache');
        resetRowCache();
        const loader = vi.fn(async () => [{ Id: 'a', Payload: { id: 'a' } }]);
        const fakeDb = {} as never;
        await loadEntityRows('albums', fakeDb, loader);
        expect(debugLocalCache().rows.albums.count).toBe(1);

        // A pure background revalidate marks the fuse index stale but must
        // leave the grid row cache intact — otherwise the next scroll pays a
        // full-table re-toArray()+re-sort.
        markSearchDirty('albums');

        await loadEntityRows('albums', fakeDb, loader);
        expect(loader).toHaveBeenCalledTimes(1);
        expect(debugLocalCache().rows.albums.count).toBe(1);
        resetRowCache();
    });

    it('rebuilds the index after markSearchDirty so fresh rows show up', async () => {
        // Prime
        const first = await searchAlbumsLocal('Abbey Road');
        expect(first).toHaveLength(1);

        // Mutate the underlying row set and mark dirty
        ROWS.albums.push({
            Id: 'al3',
            Payload: {
                albumArtists: [{ id: 'aa3', name: 'Radiohead' }],
                id: 'al3',
                name: 'OK Computer',
            } as Album,
        });
        markSearchDirty('albums');

        const second = await searchAlbumsLocal('OK Computer');
        expect(second.some((a) => a.id === 'al3')).toBe(true);

        // Restore the array for other tests
        ROWS.albums.pop();
        markSearchDirty('albums');
    });

    it('shares one in-flight build and does not install it after a dirty mark overtook it', async () => {
        const spy = vi.spyOn(mockDb.albums, 'offset');
        const [a, b] = await Promise.all([
            searchAlbumsLocal('Abbey Road'),
            searchAlbumsLocal('Abbey Road'),
        ]);
        expect(a).toHaveLength(1);
        expect(b).toHaveLength(1);
        // Concurrent callers coalesced into a single table read.
        expect(spy).toHaveBeenCalledTimes(1);

        // A dirty mark landing while a rebuild is in flight: the build read the
        // pre-change rows, so it must not be installed as the clean index.
        markSearchDirty('albums');
        const inFlight = searchAlbumsLocal('OK Computer');
        ROWS.albums.push({
            Id: 'al3',
            Payload: {
                albumArtists: [{ id: 'aa3', name: 'Radiohead' }],
                id: 'al3',
                name: 'OK Computer',
            } as Album,
        });
        markSearchDirty('albums');
        expect(await inFlight).toHaveLength(0);
        expect((await searchAlbumsLocal('OK Computer')).some((x) => x.id === 'al3')).toBe(true);

        ROWS.albums.pop();
        markSearchDirty('albums');
    });
});
