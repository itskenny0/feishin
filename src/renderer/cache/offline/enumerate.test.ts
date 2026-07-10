import type { Mock } from 'vitest';

import { describe, expect, it, vi } from 'vitest';

import type { OfflineTargetRow } from '../types';

import { streamTargetSongs } from './enumerate';

import { api } from '/@/renderer/api';

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getPlaylistSongList: vi.fn(),
        },
    },
}));

const getPlaylistSongList = api.controller.getPlaylistSongList as unknown as Mock;

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
