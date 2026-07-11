import type { Mock } from 'vitest';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfflineTargetRow } from '../types';

import { setEnumerateRetryBaseMsForTests, streamTargetSongs, withRetry } from './enumerate';

import { api } from '/@/renderer/api';

// Isolate mock state between tests (clears leftover once-queues) + no real
// backoff delay.
beforeEach(() => {
    vi.resetAllMocks();
    setEnumerateRetryBaseMsForTests(0);
});

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getAlbumDetail: vi.fn(),
            getPlaylistSongList: vi.fn(),
            getSongDetail: vi.fn(),
            getSongList: vi.fn(),
        },
    },
}));

const getAlbumDetail = api.controller.getAlbumDetail as unknown as Mock;
const getPlaylistSongList = api.controller.getPlaylistSongList as unknown as Mock;
const getSongDetail = api.controller.getSongDetail as unknown as Mock;
const getSongList = api.controller.getSongList as unknown as Mock;

const drain = async (t: OfflineTargetRow): Promise<unknown[]> => {
    const out: unknown[] = [];
    for await (const page of streamTargetSongs(t)) out.push(...page);
    return out;
};

const typed = (entityType: OfflineTargetRow['EntityType'], id: string): OfflineTargetRow =>
    ({
        EntityId: id,
        EntityType: entityType,
        Key: `s:${entityType}:${id}`,
        ServerId: 's',
    }) as OfflineTargetRow;

const target = (): OfflineTargetRow =>
    ({
        EntityId: 'p1',
        EntityType: 'playlist',
        Key: 's:playlist:p1',
        ServerId: 's',
    }) as OfflineTargetRow;

const songs = (n: number, base = 0): unknown[] =>
    Array.from({ length: n }, (_, i) => ({ id: `song${base + i}` }));

describe('streamTargetSongs (playlist paging)', () => {
    it('yields each page as it arrives', async () => {
        getPlaylistSongList
            .mockResolvedValueOnce({ items: songs(500, 0) })
            .mockResolvedValueOnce({ items: songs(3, 500) });
        const pages: number[] = [];
        for await (const page of streamTargetSongs(target())) pages.push(page.length);
        expect(pages).toEqual([500, 3]);
    });

    it('a mid-stream page error (all retries) ends the stream without throwing', async () => {
        getPlaylistSongList
            .mockResolvedValueOnce({ items: songs(500, 0) })
            .mockRejectedValue(new Error('boom')); // page 2 fails every retry
        const pages: number[] = [];
        await expect(
            (async () => {
                for await (const page of streamTargetSongs(target())) pages.push(page.length);
            })(),
        ).resolves.toBeUndefined();
        expect(pages).toEqual([500]);
    });

    it('a first-page error (all retries) throws (nothing enumerated)', async () => {
        getPlaylistSongList.mockRejectedValue(new Error('boom'));
        await expect(
            (async () => {
                for await (const page of streamTargetSongs(target())) void page;
            })(),
        ).rejects.toThrow('boom');
    });

    it('retries a transient page error then succeeds', async () => {
        getPlaylistSongList
            .mockRejectedValueOnce(new Error('502'))
            .mockResolvedValueOnce({ items: songs(3, 0) });
        const pages: number[] = [];
        for await (const page of streamTargetSongs(target())) pages.push(page.length);
        expect(pages).toEqual([3]);
        expect(getPlaylistSongList).toHaveBeenCalledTimes(2); // 1 fail + 1 success
    });
});

describe('withRetry', () => {
    it('retries a transient failure then returns the value', async () => {
        let n = 0;
        const fn = vi.fn(async () => {
            n += 1;
            if (n < 3) throw new Error('502');
            return 'ok';
        });
        await expect(withRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('gives up after MAX_ATTEMPTS (no infinite loop)', async () => {
        const fn = vi.fn(async () => {
            throw new Error('502');
        });
        await expect(withRetry(fn)).rejects.toThrow('502');
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it('never retries an abort', async () => {
        const fn = vi.fn(async () => {
            throw new DOMException('aborted', 'AbortError');
        });
        await expect(withRetry(fn)).rejects.toThrow();
        expect(fn).toHaveBeenCalledTimes(1);
    });
});

describe('streamTargetSongs (entity-type routing)', () => {
    it('albums use getAlbumDetail.songs in one page', async () => {
        getAlbumDetail.mockResolvedValue({ songs: songs(2) });
        expect(await drain(typed('album', 'al1'))).toHaveLength(2);
        expect(getAlbumDetail).toHaveBeenCalledWith(
            expect.objectContaining({ query: { id: 'al1', limit: 500, startIndex: 0 } }),
        );
    });

    it('albums page through when the tracklist exceeds one page', async () => {
        // A full page (500) means "there may be more" → fetch the next page from
        // the running startIndex; a short page ends the stream. This is the fix
        // for anomalously large albums that timed out as one unbounded request.
        getAlbumDetail
            .mockResolvedValueOnce({ songs: songs(500) })
            .mockResolvedValueOnce({ songs: songs(3) });
        expect(await drain(typed('album', 'al1'))).toHaveLength(503);
        expect(getAlbumDetail).toHaveBeenCalledTimes(2);
        expect(getAlbumDetail).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ query: { id: 'al1', limit: 500, startIndex: 0 } }),
        );
        expect(getAlbumDetail).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ query: { id: 'al1', limit: 500, startIndex: 500 } }),
        );
    });

    it('single songs use getSongDetail', async () => {
        getSongDetail.mockResolvedValue({ id: 's9' });
        expect(await drain(typed('song', 's9'))).toEqual([{ id: 's9' }]);
    });

    it('artists filter getSongList by albumArtistIds', async () => {
        getSongList.mockResolvedValueOnce({ items: songs(1) });
        await drain(typed('artist', 'ar1'));
        expect(getSongList).toHaveBeenCalledWith(
            expect.objectContaining({
                query: expect.objectContaining({ albumArtistIds: ['ar1'], genreIds: undefined }),
            }),
        );
    });

    it('genres filter getSongList by genreIds', async () => {
        getSongList.mockResolvedValueOnce({ items: songs(1) });
        await drain(typed('genre', 'g1'));
        expect(getSongList).toHaveBeenCalledWith(
            expect.objectContaining({
                query: expect.objectContaining({ albumArtistIds: undefined, genreIds: ['g1'] }),
            }),
        );
    });
});
