// useSongListQuery cache read: `limit: -1` is the controllers' "no limit"
// sentinel (the album detail-list rows ask for an album's whole tracklist
// that way), so the cached page must not drop the album's last track.

import type { CachedSong } from '/@/renderer/cache/types';

import { describe, expect, it, vi } from 'vitest';

interface CapturedArgs {
    fromCache: (db: unknown) => Promise<undefined | { items: { id: string }[] }>;
}

vi.mock('/@/renderer/cache', async () => {
    const { filterSongsLocal } = await import('/@/renderer/cache/local-filter');
    return {
        buildListSignature: (label: string) => label,
        filterSongsLocal,
        getOrComputeSorted: (_entity: string, _sig: string, compute: () => Promise<unknown>) =>
            compute(),
        loadSongsRows: async () => [],
        markRowsChangedFromPage: vi.fn(),
        markSearchDirty: vi.fn(),
        pageRefsFromItems: vi.fn(),
        toCachedSongRow: (song: unknown) => song,
        // Hand the hook's options back so the test can drive fromCache.
        useCachedQuery: (args: CapturedArgs) => args,
    };
});
vi.mock('/@/renderer/api/controller', () => ({ controller: {} }));

import { useSongListQuery } from '/@/renderer/features/songs/queries/songs-queries';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

const songRow = (id: string, track: number): CachedSong =>
    ({
        __cachedAt: 0,
        AlbumId: 'album-1',
        DateLastSaved: '',
        Id: id,
        IndexNumber: track,
        ParentIndexNumber: 1,
        Payload: { albumId: 'album-1', discNumber: 1, id, name: id, trackNumber: track },
    }) as unknown as CachedSong;

const db = {
    songs: {
        where: () => ({
            equals: () => ({
                toArray: async () => [songRow('t1', 1), songRow('t2', 2), songRow('t3', 3)],
            }),
        }),
    },
};

describe('useSongListQuery cache pagination', () => {
    it('serves the whole album for limit -1', async () => {
        const args = useSongListQuery({
            query: {
                albumIds: ['album-1'],
                limit: -1,
                sortBy: SongListSort.ALBUM,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
            serverId: 'server-1',
        }) as unknown as CapturedArgs;
        const result = await args.fromCache(db);
        expect(result?.items.map((s) => s.id)).toEqual(['t1', 't2', 't3']);
    });
});
