// albumQueries.list cache read: `limit: -1` is the controllers' "no limit"
// sentinel (the artist page asks for every album that way), so the cached
// page must not treat it as a slice end and drop the last album.

import type { CachedAlbum } from '/@/renderer/cache/types';

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock('/@/renderer/cache', async () => {
    const { filterAlbumsLocal } = await import('/@/renderer/cache/local-filter');
    return {
        buildListSignature: (label: string) => label,
        cachedSwr: (args: { fromCache: (db: unknown) => Promise<unknown> }) => args.fromCache({}),
        filterAlbumsLocal,
        getOrComputeSorted: (_entity: string, _sig: string, compute: () => Promise<unknown>) =>
            compute(),
        loadAlbumsRows: async () => mocks.rows,
        readEntityCountFallback: () => undefined,
        readSnapshot: () => undefined,
        toCachedAlbumRow: (album: unknown) => album,
        toCachedSongRow: (song: unknown) => song,
    };
});
vi.mock('/@/renderer/api', () => ({ api: { controller: {} } }));
vi.mock('/@/renderer/api/controller', () => ({ controller: {} }));
vi.mock('/@/renderer/api/utils-list-count', () => ({ getOptimizedListCount: vi.fn() }));
vi.mock('/@/renderer/lib/react-query', () => ({}));

import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { AlbumListResponse, AlbumListSort, SortOrder } from '/@/shared/types/domain-types';

const albumRow = (id: string): CachedAlbum =>
    ({
        __cachedAt: 0,
        AlbumArtistId: 'artist-1',
        DateLastSaved: '',
        GenreIds: [],
        Id: id,
        Payload: { albumArtists: [{ id: 'artist-1', name: 'A' }], id, name: id },
        SortName: id,
    }) as unknown as CachedAlbum;

const runList = async (limit: number | undefined, startIndex = 0) => {
    const options = albumQueries.list({
        query: { limit, sortBy: AlbumListSort.NAME, sortOrder: SortOrder.ASC, startIndex },
        serverId: 'server-1',
    });
    const queryFn = options.queryFn as unknown as (ctx: unknown) => Promise<AlbumListResponse>;
    return queryFn({ client: {}, signal: undefined });
};

describe('albumQueries.list cache pagination', () => {
    it('serves every album for limit -1', async () => {
        mocks.rows = ['a', 'b', 'c'].map(albumRow);
        const result = await runList(-1);
        expect(result.items.map((a) => a.id)).toEqual(['a', 'b', 'c']);
        expect(result.totalRecordCount).toBe(3);
    });

    it('still slices a positive limit', async () => {
        mocks.rows = ['a', 'b', 'c'].map(albumRow);
        const result = await runList(2, 1);
        expect(result.items.map((a) => a.id)).toEqual(['b', 'c']);
    });
});
