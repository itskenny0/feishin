// Regression tests for the offline play-by-fetch fallback.
//
// "Play" on an album/artist/playlist goes through fetchSongsByItemType, which
// used to be network-only: with the server unreachable the enqueue failed
// outright — even for fully-downloaded ("available offline") items. The local
// resolver answers those fetches from Dexie so cached/offline items can play.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const songsRows: any[] = [];
    const playlistSongsRows: any[] = [];
    const byIndex = (rows: any[], index: string, values: string[]) =>
        rows.filter((r) => values.includes(r[index]));
    const makeWhere = (rows: any[]) =>
        vi.fn((index: string) => ({
            anyOf: (values: string[]) => ({
                sortBy: async (field: string) =>
                    [...byIndex(rows, index, values)].sort((a, b) => a[field] - b[field]),
                toArray: async () => byIndex(rows, index, values),
            }),
        }));
    const db = {
        playlistSongs: { where: makeWhere(playlistSongsRows) },
        songs: { where: makeWhere(songsRows) },
    };
    return { db, playlistSongsRows, songsRows };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

import { resolveSongsByItemTypeLocal } from '/@/renderer/cache/local-songs-by-item';
import { LibraryItem } from '/@/shared/types/domain-types';

const songRow = (id: string, albumId: string, disc: number, track: number) => ({
    AlbumArtistId: 'artist-1',
    AlbumId: albumId,
    Id: id,
    Payload: { discNumber: disc, id, name: id, trackNumber: track },
});

beforeEach(() => {
    mocks.songsRows.length = 0;
    mocks.playlistSongsRows.length = 0;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('resolveSongsByItemTypeLocal', () => {
    it('resolves album songs from Dexie in disc/track order', async () => {
        mocks.songsRows.push(
            songRow('s3', 'al1', 2, 1),
            songRow('s1', 'al1', 1, 1),
            songRow('s2', 'al1', 1, 2),
            songRow('sx', 'al2', 1, 1),
        );

        const songs = await resolveSongsByItemTypeLocal({
            id: ['al1'],
            itemType: LibraryItem.ALBUM,
        });

        expect(songs?.map((s) => s.id)).toEqual(['s1', 's2', 's3']);
    });

    it('resolves playlist songs in list order', async () => {
        mocks.playlistSongsRows.push(
            { ListOrder: 2, PlaylistId: 'pl1', SongPayload: { id: 'p2' } },
            { ListOrder: 1, PlaylistId: 'pl1', SongPayload: { id: 'p1' } },
        );

        const songs = await resolveSongsByItemTypeLocal({
            id: ['pl1'],
            itemType: LibraryItem.PLAYLIST,
        });

        expect(songs?.map((s) => s.id)).toEqual(['p1', 'p2']);
    });

    // Pinned songs on the homepage play via addToQueueByFetch(serverId, [id],
    // SONG, …) — the resolver must answer plain song ids too (device,
    // 2026-06-11: tapping a pinned song did nothing).
    it('resolves individual songs by id, preserving request order', async () => {
        mocks.songsRows.push(
            songRow('s1', 'al1', 1, 1),
            songRow('s2', 'al1', 1, 2),
            songRow('s3', 'al2', 1, 1),
        );

        const songs = await resolveSongsByItemTypeLocal({
            id: ['s3', 's1'],
            itemType: LibraryItem.SONG,
        });

        expect(songs?.map((s) => s.id)).toEqual(['s3', 's1']);
    });

    it('returns undefined when nothing is cached (caller keeps the network error)', async () => {
        const songs = await resolveSongsByItemTypeLocal({
            id: ['al-missing'],
            itemType: LibraryItem.ALBUM,
        });
        expect(songs).toBeUndefined();
    });

    it('returns undefined for item types the cache cannot answer', async () => {
        const songs = await resolveSongsByItemTypeLocal({
            id: ['folder1'],
            itemType: LibraryItem.FOLDER,
        });
        expect(songs).toBeUndefined();
    });
});
