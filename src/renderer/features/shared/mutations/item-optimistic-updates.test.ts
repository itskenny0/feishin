import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { queryKeys } from '/@/renderer/api/query-keys';
import {
    applyItemOptimisticUpdates,
    ItemPatch,
    restoreQueryData,
} from '/@/renderer/features/shared/mutations/item-optimistic-updates';
import { LibraryItem } from '/@/shared/types/domain-types';

const S = 'server-1';
const loaderKey = (type: LibraryItem) => [S, 'item-list-infinite-loader', type, { q: 1 }];

const item = (id: string) => ({ id, userFavorite: false, userRating: null });
const pages = (...ids: string[]) => ({
    pageParams: ['0'],
    pages: [{ items: ids.map(item), startIndex: 0, totalRecordCount: ids.length }],
});
const list = (...ids: string[]) => ({ items: ids.map(item), startIndex: 0, totalRecordCount: 1 });

const seed = (qc: QueryClient) => {
    const keys: Record<string, readonly unknown[]> = {
        albumArtistDetail: [...queryKeys.albumArtists.detail(S), { id: 'aa1' }],
        albumArtistInfiniteList: [...queryKeys.albumArtists.infiniteList(S), { q: 1 }],
        albumArtistInfo: [...queryKeys.albumArtists.info(S), { id: 'x' }],
        albumArtistList: [...queryKeys.albumArtists.list(S), { q: 1 }],
        albumArtistLoader: loaderKey(LibraryItem.ALBUM_ARTIST),
        albumDetail: [...queryKeys.albums.detail(S), { id: 'al1' }],
        albumDetailWithSongs: [...queryKeys.albums.detail(S), { id: 'al2' }],
        albumInfiniteList: [...queryKeys.albums.infiniteList(S), { q: 1 }],
        albumList: [...queryKeys.albums.list(S), { q: 1 }],
        albumLoader: loaderKey(LibraryItem.ALBUM),
        artistInfiniteList: [...queryKeys.artists.infiniteList(S), { q: 1 }],
        artistList: [...queryKeys.artists.list(S), { q: 1 }],
        artistLoader: loaderKey(LibraryItem.ARTIST),
        homeAlbum: ['home', 'album', S],
        homeSong: ['home', 'song', S],
        otherServerAlbumList: [...queryKeys.albums.list('server-2'), { q: 1 }],
        playlistSongList: [...queryKeys.playlists.songList(S), 'p1'],
        songDetail: [...queryKeys.songs.detail(S), { id: 's1' }],
        songList: [...queryKeys.songs.list(S), { q: 1 }],
        topSongs: [...queryKeys.albumArtists.topSongs(S), { q: 1 }],
    };

    const data: Record<string, unknown> = {
        albumArtistDetail: item('aa1'),
        albumArtistInfiniteList: pages('aa1', 'aa2'),
        albumArtistInfo: { similarArtists: [item('aa1'), item('aa3')] },
        albumArtistList: list('aa1', 'aa2'),
        albumArtistLoader: { data: [item('aa1'), item('aa2')], pagesLoaded: { 0: true } },
        albumDetail: { ...item('al1'), songs: [item('s9')] },
        albumDetailWithSongs: { ...item('al2'), songs: [item('s1'), item('s2')] },
        albumInfiniteList: pages('al1', 'al3'),
        albumList: list('al1', 'al3'),
        albumLoader: { data: [item('al1'), item('al3')], pagesLoaded: { 0: true } },
        artistInfiniteList: pages('ar1'),
        artistList: list('ar1', 'ar2'),
        artistLoader: { data: [item('ar1')], pagesLoaded: { 0: true } },
        homeAlbum: pages('al1'),
        homeSong: pages('s1', 's2'),
        otherServerAlbumList: list('al1'),
        playlistSongList: list('s1', 's3'),
        songDetail: item('s1'),
        songList: list('s1'),
        topSongs: list('s2', 's1'),
    };

    Object.entries(keys).forEach(([name, key]) => qc.setQueryData(key, data[name]));

    const get = (name: string) => qc.getQueryData<any>(keys[name]);
    const snapshot = () =>
        Object.fromEntries(Object.keys(keys).map((name) => [name, structuredClone(get(name))]));

    return { get, snapshot };
};

const variants: { field: 'userFavorite' | 'userRating'; patch: ItemPatch; value: unknown }[] = [
    { field: 'userFavorite', patch: { userFavorite: true }, value: true },
    { field: 'userRating', patch: { userRating: 4 }, value: 4 },
];

describe.each(variants)('optimistic $field updates', ({ field, patch, value }) => {
    const apply = (qc: QueryClient, ids: string[], type: LibraryItem) =>
        applyItemOptimisticUpdates(qc, S, ids, type, patch);
    const restore = restoreQueryData;

    it('patches every cached album surface for the album ids, then restores', () => {
        const qc = new QueryClient();
        const { get, snapshot } = seed(qc);
        const before = snapshot();

        const previous = apply(qc, ['al1'], LibraryItem.ALBUM);

        expect(get('albumDetail')[field]).toBe(value);
        expect(get('albumDetailWithSongs')[field]).toBe(before.albumDetailWithSongs[field]);
        expect(get('albumList').items.map((i: any) => i[field])).toEqual([
            value,
            item('al3')[field],
        ]);
        expect(get('albumInfiniteList').pages[0].items[0][field]).toBe(value);
        expect(get('albumInfiniteList').pageParams).toEqual(['0']);
        expect(get('homeAlbum').pages[0].items[0][field]).toBe(value);
        expect(get('albumLoader').data[0][field]).toBe(value);
        expect(get('albumLoader').data[1][field]).toBe(item('al3')[field]);
        // Another server's cache is untouched.
        expect(get('otherServerAlbumList')).toEqual(before.otherServerAlbumList);
        // Song surfaces are untouched for an album mutation.
        expect(get('songList')).toEqual(before.songList);

        restore(qc, previous);
        expect(snapshot()).toEqual(before);
    });

    it('patches album artist detail, similar artists, lists and loaders', () => {
        const qc = new QueryClient();
        const { get, snapshot } = seed(qc);
        const before = snapshot();

        const previous = apply(qc, ['aa1'], LibraryItem.ALBUM_ARTIST);

        expect(get('albumArtistDetail')[field]).toBe(value);
        expect(get('albumArtistInfo').similarArtists.map((a: any) => a[field])).toEqual([
            value,
            item('aa3')[field],
        ]);
        expect(get('albumArtistList').items[0][field]).toBe(value);
        expect(get('albumArtistList').items[1][field]).toBe(item('aa2')[field]);
        expect(get('albumArtistInfiniteList').pages[0].items[0][field]).toBe(value);
        expect(get('albumArtistLoader').data[0][field]).toBe(value);
        expect(get('albumList')).toEqual(before.albumList);

        restore(qc, previous);
        expect(snapshot()).toEqual(before);
    });

    it('patches artist lists and loaders', () => {
        const qc = new QueryClient();
        const { get, snapshot } = seed(qc);
        const before = snapshot();

        const previous = apply(qc, ['ar1'], LibraryItem.ARTIST);

        expect(get('artistList').items[0][field]).toBe(value);
        expect(get('artistList').items[1][field]).toBe(item('ar2')[field]);
        expect(get('artistInfiniteList').pages[0].items[0][field]).toBe(value);
        expect(get('artistLoader').data[0][field]).toBe(value);

        restore(qc, previous);
        expect(snapshot()).toEqual(before);
    });

    it.each([LibraryItem.SONG, LibraryItem.PLAYLIST_SONG, LibraryItem.QUEUE_SONG])(
        'patches every song surface for %s',
        (type) => {
            const qc = new QueryClient();
            const { get, snapshot } = seed(qc);
            const before = snapshot();

            const previous = apply(qc, ['s1'], type);

            expect(get('albumDetailWithSongs').songs.map((s: any) => s[field])).toEqual([
                value,
                item('s2')[field],
            ]);
            expect(get('albumDetailWithSongs')[field]).toBe(before.albumDetailWithSongs[field]);
            expect(get('albumDetail')).toEqual(before.albumDetail);
            expect(get('songDetail')[field]).toBe(value);
            expect(get('playlistSongList').items[0][field]).toBe(value);
            expect(get('playlistSongList').items[1][field]).toBe(item('s3')[field]);
            expect(get('songList').items[0][field]).toBe(value);
            expect(get('topSongs').items[1][field]).toBe(value);
            expect(get('homeSong').pages[0].items[0][field]).toBe(value);
            expect(get('homeSong').pages[0].items[1][field]).toBe(item('s2')[field]);

            restore(qc, previous);
            expect(snapshot()).toEqual(before);
        },
    );

    it('does nothing for an id that is not cached anywhere', () => {
        const qc = new QueryClient();
        const { snapshot } = seed(qc);
        const before = snapshot();

        apply(qc, ['missing'], LibraryItem.SONG);

        expect(snapshot()).toEqual(before);
    });
});
