// songsQueries.listCount cache read: the infinite song list takes its row
// count from here and its pages from the local filter, so the two must agree
// or the list shows phantom rows (and sync-first never corrects it).

import type { CachedSong } from '/@/renderer/cache/types';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    favorites: [] as { IsFavorite: boolean; ItemId: string; Rating?: number }[],
    rows: [] as unknown[],
}));

const fakeDb = {
    favorites: {
        where: () => ({ equals: () => ({ toArray: async () => mocks.favorites }) }),
    },
    songs: {
        count: async () => mocks.rows.length,
        toArray: async () => mocks.rows,
        where: () => ({
            equals: (id: string) => ({
                count: async () =>
                    (mocks.rows as CachedSong[]).filter((r) => r.AlbumId === id).length,
                toArray: async () => (mocks.rows as CachedSong[]).filter((r) => r.AlbumId === id),
            }),
        }),
    },
};

vi.mock('/@/renderer/cache', async () => {
    const { cacheFavoriteCount, filterSongsLocal } = await import('/@/renderer/cache/local-filter');
    return {
        cachedSwr: (args: { fromCache: (db: unknown) => Promise<unknown> }) =>
            args.fromCache(fakeDb),
        cacheFavoriteCount,
        filterSongsLocal,
        loadSongsRows: async () => mocks.rows,
        readEntityCountFallback: () => undefined,
        readSnapshot: () => undefined,
        toCachedSongRow: (song: unknown) => song,
    };
});
vi.mock('/@/renderer/api', () => ({ api: { controller: {} } }));
vi.mock('/@/renderer/api/controller', () => ({ controller: {} }));
vi.mock('/@/renderer/api/utils-list-count', () => ({ getOptimizedListCount: vi.fn() }));
vi.mock('/@/renderer/lib/react-query', () => ({}));

import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { SongListQuery } from '/@/shared/types/domain-types';

const songRow = (id: string, name: string, releaseYear: number, albumId = 'album-1'): CachedSong =>
    ({
        AlbumId: albumId,
        Id: id,
        Payload: { album: '', albumArtistName: '', id, name, releaseYear },
    }) as unknown as CachedSong;

const runCount = (query: Partial<SongListQuery>) => {
    const options = songsQueries.listCount({ query: query as SongListQuery, serverId: 'server-1' });
    const queryFn = options.queryFn as unknown as (ctx: unknown) => Promise<number | undefined>;
    return queryFn({ client: {}, signal: undefined });
};

describe('songsQueries.listCount from cache', () => {
    mocks.rows = [
        songRow('1', 'Blue Song', 1990),
        songRow('2', 'Red Song', 2001),
        songRow('3', 'Blue Moon', 2005, 'album-2'),
    ];
    mocks.favorites = [
        { IsFavorite: true, ItemId: '1' },
        { IsFavorite: true, ItemId: '2', Rating: 4 },
    ];

    it('counts favourites matching the search term, not every favourite', async () => {
        expect(await runCount({ favorite: true, searchTerm: 'blue' })).toBe(1);
    });

    it('applies a year range instead of returning the whole library', async () => {
        expect(await runCount({ minYear: 2000 })).toBe(2);
    });

    it('applies the has-rating filter', async () => {
        expect(await runCount({ hasRating: true })).toBe(1);
    });

    it('falls back to the network for filters the cache cannot answer', async () => {
        expect(await runCount({ _custom: { GenreIds: 'g1' } })).toBeUndefined();
    });

    it('keeps the cheap paths', async () => {
        expect(await runCount({})).toBe(3);
        expect(await runCount({ favorite: true })).toBe(2);
        expect(await runCount({ albumIds: ['album-2'] })).toBe(1);
    });

    it('applies other filters on top of a single-album lookup', async () => {
        expect(await runCount({ albumIds: ['album-1'], minYear: 2000 })).toBe(1);
    });
});
