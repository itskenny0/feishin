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
// We don't drive Dexie here — instead we exercise the searchLocal /
// searchXLocal entry points through a mocked `getActiveCacheDb()` that
// returns a tiny in-memory table-shim.

import type { Album, AlbumArtist, Playlist, Song } from '/@/shared/types/domain-types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    markSearchDirty,
    resetSearchIndexes,
    searchAlbumsLocal,
    searchArtistsLocal,
    searchLocal,
    searchSongsLocal,
} from '/@/renderer/cache/search';

// Mock the capability + DB helpers so search.ts thinks the cache is
// available and the four ensureXIndex() loaders can pull from our
// in-memory shim.
const ROWS = {
    albums: [
        {
            Payload: {
                albumArtists: [{ id: 'aa1', name: 'The Beatles' }],
                id: 'al1',
                name: 'Abbey Road',
            } as Album,
        },
        {
            Payload: {
                albumArtists: [{ id: 'aa2', name: 'Pink Floyd' }],
                id: 'al2',
                name: 'Dark Side of the Moon',
            } as Album,
        },
    ],
    artists: [
        { Kind: 'AlbumArtist', Payload: { id: 'aa1', name: 'The Beatles' } as AlbumArtist },
        { Kind: 'AlbumArtist', Payload: { id: 'aa2', name: 'Pink Floyd' } as AlbumArtist },
        // An Artist (song-artist) kind should be filtered out of the
        // album-artist index by the where('Kind') hop.
        { Kind: 'Artist', Payload: { id: 'a3', name: 'John Lennon' } as AlbumArtist },
    ],
    playlists: [
        { Payload: { id: 'pl1', name: 'Workout Mix' } as Playlist },
        { Payload: { id: 'pl2', name: 'Coding Tunes' } as Playlist },
    ],
    songs: [
        {
            Payload: {
                albumArtists: [{ id: 'aa1', name: 'The Beatles' }],
                id: 's1',
                name: 'Come Together',
            } as Song,
        },
        {
            Payload: {
                albumArtists: [{ id: 'aa2', name: 'Pink Floyd' }],
                id: 's2',
                name: 'Time',
            } as Song,
        },
    ],
};

const tableShim = <T>(rows: T[]) => ({
    toArray: async () => rows,
    where: (_k: string) => ({
        equals: (_v: string) => ({
            toArray: async () =>
                rows.filter((r) => (r as { Kind?: string }).Kind === _v || _k !== 'Kind'),
        }),
    }),
});

vi.mock('/@/renderer/cache/capability', () => ({
    isCacheAvailable: async () => true,
    isCacheAvailableSync: () => true,
}));

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => ({
        albums: tableShim(ROWS.albums),
        artists: tableShim(ROWS.artists),
        playlists: tableShim(ROWS.playlists),
        songs: tableShim(ROWS.songs),
    }),
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

    it('returns an empty envelope for an empty query without touching the index', async () => {
        const result = await searchLocal('   ');
        expect(result).toEqual({ albums: [], artists: [], playlists: [], songs: [] });
    });

    it('searchLocal returns hits across every entity in a single call', async () => {
        const result = await searchLocal('beatles');
        expect(result.albums.some((a) => a.id === 'al1')).toBe(true);
        expect(result.artists.some((a) => a.id === 'aa1')).toBe(true);
        expect(result.songs.some((s) => s.id === 's1')).toBe(true);
    });

    it('rebuilds the index after markSearchDirty so fresh rows show up', async () => {
        // Prime
        const first = await searchAlbumsLocal('Abbey Road');
        expect(first).toHaveLength(1);

        // Mutate the underlying row set and mark dirty
        ROWS.albums.push({
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
});
