// RANDOM-sort pagination contract for the cache page resolvers.
//
// RANDOM must be computed ONCE per query scope (memoized full permutation,
// pages sliced out of it) — re-shuffling per page hands out duplicate and
// skipped rows across page boundaries. The album-detail / home carousels
// (useAlbumInfiniteListSuspenseQuery) ride on resolveAlbumPage for exactly
// this guarantee.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const albums: any[] = [];
    const db = {
        albums: {
            count: vi.fn(async () => albums.length),
            toArray: vi.fn(async () => [...albums]),
            where: vi.fn(() => ({
                equals: () => ({ toArray: async () => [] }),
            })),
        },
        favorites: {
            where: vi.fn(() => ({
                equals: () => ({ toArray: async () => [] }),
            })),
        },
    };
    return { albums, db };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/capability', () => ({
    isCacheAvailableSync: () => true,
}));

import { resolveAlbumPage } from '/@/renderer/cache/grid-resolver';
import { resetRowCache } from '/@/renderer/cache/local-cache';
import { AlbumListSort, SortOrder } from '/@/shared/types/domain-types';

const albumRow = (i: number) => ({
    AlbumArtistId: `artist-${i % 3}`,
    Id: `album-${i}`,
    Payload: { id: `album-${i}`, name: `Album ${i}` },
    SortName: `album ${String(i).padStart(2, '0')}`,
});

const RANDOM_QUERY = {
    sortBy: AlbumListSort.RANDOM,
    sortOrder: SortOrder.ASC,
} as any;

beforeEach(() => {
    mocks.albums.length = 0;
    for (let i = 0; i < 30; i += 1) mocks.albums.push(albumRow(i));
    resetRowCache();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('resolveAlbumPage — RANDOM pagination coherence', () => {
    it('serves every page from ONE permutation: no duplicates, no skips', async () => {
        const ids: string[] = [];
        for (let start = 0; start < 30; start += 10) {
            const page = await resolveAlbumPage({
                limit: 10,
                query: RANDOM_QUERY,
                startIndex: start,
            });
            expect(page).toBeDefined();
            ids.push(...(page!.items as any[]).map((a) => a.id));
        }

        // 3 pages of 10 must reconstruct the full set exactly once each.
        expect(ids).toHaveLength(30);
        expect(new Set(ids).size).toBe(30);
    });

    it('repeated reads of the same page are stable within the memo lifetime', async () => {
        const first = await resolveAlbumPage({ limit: 10, query: RANDOM_QUERY, startIndex: 0 });
        const again = await resolveAlbumPage({ limit: 10, query: RANDOM_QUERY, startIndex: 0 });
        expect((again!.items as any[]).map((a) => a.id)).toEqual(
            (first!.items as any[]).map((a) => a.id),
        );
    });

    it('reports the full result envelope so infinite consumers can page correctly', async () => {
        const page = await resolveAlbumPage({ limit: 10, query: RANDOM_QUERY, startIndex: 10 });
        expect(page).toBeDefined();
        expect(page!.startIndex).toBe(10);
        expect(page!.totalRecordCount).toBe(30);
    });
});
