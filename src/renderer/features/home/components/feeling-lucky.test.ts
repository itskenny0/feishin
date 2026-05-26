import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedSong } from '/@/renderer/cache/types';

import { describe, expect, it } from 'vitest';

import { pickRandomFromCache } from '/@/renderer/features/home/components/feeling-lucky';

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
