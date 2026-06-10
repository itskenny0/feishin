import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedSong } from '/@/renderer/cache/types';

import { describe, expect, it } from 'vitest';

import {
    offlineSongIdsForServer,
    pickRandomFromCache,
    pickRandomOfflineFromCache,
} from '/@/renderer/features/home/components/feeling-lucky';

const row = (id: string): CachedSong =>
    ({
        __cachedAt: 0,
        AlbumArtistId: undefined,
        AlbumId: undefined,
        DateLastSaved: '',
        Id: id,
        IndexNumber: undefined,
        ParentIndexNumber: undefined,
        Payload: { id, name: `song-${id}` },
    }) as unknown as CachedSong;

const fakeDb = (rows: CachedSong[]): LibraryCacheDb =>
    ({
        songs: {
            bulkGet: async (ids: string[]) => ids.map((id) => rows.find((r) => r.Id === id)),
            toCollection: () => ({ primaryKeys: async () => rows.map((r) => r.Id) }),
        },
    }) as unknown as LibraryCacheDb;

describe('pickRandomFromCache', () => {
    it('returns [] for an empty cache', async () => {
        const result = await pickRandomFromCache(fakeDb([]), 100);
        expect(result).toEqual([]);
    });

    it('returns at most `size` payloads', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(String(i)));
        const result = await pickRandomFromCache(fakeDb(rows), 3);
        expect(result).toHaveLength(3);
    });

    it('returns all songs when the cache holds fewer than `size`', async () => {
        const rows = [row('a'), row('b')];
        const result = await pickRandomFromCache(fakeDb(rows), 100);
        expect(result.map((s) => s.id).sort()).toEqual(['a', 'b']);
    });

    it('returns real Song payloads drawn from the cache, with no duplicates', async () => {
        const rows = [row('a'), row('b'), row('c')];
        const ids = new Set(['a', 'b', 'c']);
        const result = await pickRandomFromCache(fakeDb(rows), 2);
        result.forEach((s) => expect(ids.has(s.id)).toBe(true));
        expect(new Set(result.map((s) => s.id)).size).toBe(result.length);
    });
});

describe('offlineSongIdsForServer', () => {
    it('returns [] when nothing is downloaded', () => {
        expect(offlineSongIdsForServer(new Set(), 'srv1')).toEqual([]);
    });

    it('keeps only the requested server and strips the prefix', () => {
        const keys = new Set(['srv1:a', 'srv1:b', 'srv2:c', 'srv2:d']);
        expect(offlineSongIdsForServer(keys, 'srv1').sort()).toEqual(['a', 'b']);
        expect(offlineSongIdsForServer(keys, 'srv2').sort()).toEqual(['c', 'd']);
    });

    it('preserves song ids that themselves contain a colon', () => {
        const keys = new Set(['srv1:plain', 'srv1:weird:id']);
        expect(offlineSongIdsForServer(keys, 'srv1').sort()).toEqual(['plain', 'weird:id']);
    });
});

describe('pickRandomOfflineFromCache', () => {
    it('returns [] when the offline pool is empty', async () => {
        const rows = [row('a'), row('b')];
        const result = await pickRandomOfflineFromCache(fakeDb(rows), [], 100);
        expect(result).toEqual([]);
    });

    it('only ever returns songs from the offline pool', async () => {
        const rows = [row('a'), row('b'), row('c'), row('d')];
        const offline = ['a', 'c'];
        const result = await pickRandomOfflineFromCache(fakeDb(rows), offline, 100);
        expect(result.map((s) => s.id).sort()).toEqual(['a', 'c']);
    });

    it('returns at most `size` songs from the offline pool', async () => {
        const rows = Array.from({ length: 10 }, (_, i) => row(String(i)));
        const offline = rows.map((r) => r.Id);
        const result = await pickRandomOfflineFromCache(fakeDb(rows), offline, 3);
        expect(result).toHaveLength(3);
        expect(new Set(result.map((s) => s.id)).size).toBe(3);
    });

    it('skips downloaded ids missing from the library cache', async () => {
        const rows = [row('a')];
        const offline = ['a', 'ghost'];
        const result = await pickRandomOfflineFromCache(fakeDb(rows), offline, 100);
        expect(result.map((s) => s.id)).toEqual(['a']);
    });
});
