// The favourites sweep runs AFTER the entity sweeps, so a favourite-filtered
// list (Favourites page, sidebar section) may already have memoised its sorted
// result against the old favourites set. The sweep must drop those memos once
// it writes fresh favourite rows, or the list keeps the old membership.

import { describe, expect, it, vi } from 'vitest';

import type { LibraryCacheDb } from '../db';

vi.mock('/@/renderer/api/controller', () => ({
    controller: {
        getAlbumArtistList: vi.fn(async () => ({ items: [], totalRecordCount: 0 })),
        getAlbumList: vi.fn(async () => ({
            items: [{ id: 'new-fav-album' }],
            totalRecordCount: 1,
        })),
        getSongList: vi.fn(async () => ({ items: [], totalRecordCount: 0 })),
    },
}));

import { lookupSorted, storeSorted } from '../local-cache';
import { runFavoritesSweep } from './favorites';

describe('runFavoritesSweep', () => {
    it('drops favourite-filtered sorted memos after writing fresh favourites', async () => {
        const db = {
            favorites: {
                bulkDelete: vi.fn(async () => undefined),
                bulkPut: vi.fn(async () => undefined),
                toArray: vi.fn(async () => []),
            },
            syncMeta: {
                get: vi.fn(async () => undefined),
                put: vi.fn(async () => undefined),
            },
        } as unknown as LibraryCacheDb;

        // A favourite-filtered album list memoised before the sweep ran.
        storeSorted('albums', 'albums|favorite=true', [{ id: 'old-fav-album' }]);
        expect(lookupSorted('albums', 'albums|favorite=true')).toHaveLength(1);

        await runFavoritesSweep({ db, entity: 'favorites', signal: new AbortController().signal }, {
            id: 'srv',
        } as never);

        expect(lookupSorted('albums', 'albums|favorite=true')).toBeUndefined();
    });
});
