import type { Mock } from 'vitest';

import { describe, expect, it, vi } from 'vitest';

import type { OfflineTargetRow } from '../types';

import { streamTargetSongs } from './enumerate';

import { api } from '/@/renderer/api';

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

    it('a mid-stream page error ends the stream without throwing', async () => {
        getPlaylistSongList
            .mockResolvedValueOnce({ items: songs(500, 0) })
            .mockRejectedValueOnce(new Error('boom'));
        const pages: number[] = [];
        await expect(
            (async () => {
                for await (const page of streamTargetSongs(target())) pages.push(page.length);
            })(),
        ).resolves.toBeUndefined();
        expect(pages).toEqual([500]);
    });

    it('a first-page error throws (nothing enumerated)', async () => {
        getPlaylistSongList.mockRejectedValueOnce(new Error('boom'));
        await expect(
            (async () => {
                for await (const page of streamTargetSongs(target())) void page;
            })(),
        ).rejects.toThrow('boom');
    });
});

describe('streamTargetSongs (entity-type routing)', () => {
    it('albums use getAlbumDetail.songs in one page', async () => {
        getAlbumDetail.mockResolvedValue({ songs: songs(2) });
        expect(await drain(typed('album', 'al1'))).toHaveLength(2);
        expect(getAlbumDetail).toHaveBeenCalledWith(
            expect.objectContaining({ query: { id: 'al1' } }),
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
