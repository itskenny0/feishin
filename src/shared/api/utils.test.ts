// Pure-function tests for the cross-backend API helpers. These pin the feature
// gating logic (hasFeature / hasFeatureWithVersion / getFeatures version
// matching) and the path-prefix rewriter, all of which sit on hot list/sort
// paths shared by every server backend.

import { describe, expect, it } from 'vitest';

import {
    getFeatures,
    hasFeature,
    hasFeatureWithVersion,
    replacePathPrefix,
    sortAlbumArtistList,
    sortAlbumList,
    sortSongList,
    sortSongsByFetchedOrder,
    VersionInfo,
} from '/@/shared/api/utils';
import {
    Album,
    AlbumArtist,
    AlbumArtistListSort,
    AlbumListSort,
    LibraryItem,
    ServerListItem,
    ServerType,
    Song,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';

const server = (overrides: Partial<ServerListItem> = {}): ServerListItem => ({
    id: 'srv1',
    name: 'Test',
    type: ServerType.NAVIDROME,
    url: 'http://localhost',
    userId: null,
    username: 'tester',
    ...overrides,
});

describe('hasFeature', () => {
    it('returns false when server is null', () => {
        expect(hasFeature(null, ServerFeature.TAGS)).toBe(false);
    });

    it('returns false when server has no features map', () => {
        expect(hasFeature(server(), ServerFeature.TAGS)).toBe(false);
    });

    it('returns false when the feature is absent', () => {
        expect(hasFeature(server({ features: {} }), ServerFeature.TAGS)).toBe(false);
    });

    it('returns false when the feature array is empty', () => {
        expect(
            hasFeature(server({ features: { [ServerFeature.TAGS]: [] } }), ServerFeature.TAGS),
        ).toBe(false);
    });

    it('returns true when the feature has at least one supported version', () => {
        expect(
            hasFeature(server({ features: { [ServerFeature.TAGS]: [1] } }), ServerFeature.TAGS),
        ).toBe(true);
    });
});

describe('hasFeatureWithVersion', () => {
    it('returns false when server is null', () => {
        expect(hasFeatureWithVersion(null, ServerFeature.TAGS, 1)).toBe(false);
    });

    it('returns false when server has no features map', () => {
        expect(hasFeatureWithVersion(server(), ServerFeature.TAGS, 1)).toBe(false);
    });

    it('returns false when the requested version is not listed', () => {
        expect(
            hasFeatureWithVersion(
                server({ features: { [ServerFeature.TAGS]: [1, 2] } }),
                ServerFeature.TAGS,
                3,
            ),
        ).toBe(false);
    });

    it('returns true when the requested version is listed', () => {
        expect(
            hasFeatureWithVersion(
                server({ features: { [ServerFeature.TAGS]: [1, 2] } }),
                ServerFeature.TAGS,
                2,
            ),
        ).toBe(true);
    });
});

describe('getFeatures', () => {
    const VERSION_INFO: VersionInfo = [
        ['0.49.3', { [ServerFeature.SHARING_ALBUM_SONG]: [1] }],
        ['0.48.0', { [ServerFeature.PLAYLISTS_SMART]: [1] }],
    ];

    it('matches all features at or below the server version (descending list)', () => {
        const features = getFeatures(VERSION_INFO, '0.49.3');
        expect(features[ServerFeature.SHARING_ALBUM_SONG]).toEqual([1]);
        expect(features[ServerFeature.PLAYLISTS_SMART]).toEqual([1]);
    });

    it('matches only the newer-than-version entries when the server is mid-range', () => {
        const features = getFeatures(VERSION_INFO, '0.48.5');
        expect(features[ServerFeature.SHARING_ALBUM_SONG]).toBeUndefined();
        expect(features[ServerFeature.PLAYLISTS_SMART]).toEqual([1]);
    });

    it('matches nothing when the server is below every listed version', () => {
        expect(getFeatures(VERSION_INFO, '0.47.0')).toEqual({});
    });

    it('treats an uncoercible version string as matching everything', () => {
        const features = getFeatures(VERSION_INFO, 'not-a-version');
        expect(features[ServerFeature.SHARING_ALBUM_SONG]).toEqual([1]);
        expect(features[ServerFeature.PLAYLISTS_SMART]).toEqual([1]);
    });

    it('merges version arrays when the same feature appears in multiple entries', () => {
        const info: VersionInfo = [
            ['0.49.0', { [ServerFeature.TAGS]: [2] }],
            ['0.48.0', { [ServerFeature.TAGS]: [1] }],
        ];
        expect(getFeatures(info, '0.49.0')[ServerFeature.TAGS]).toEqual([2, 1]);
    });
});

describe('replacePathPrefix', () => {
    it('returns the path unchanged when no prefixes are supplied', () => {
        expect(replacePathPrefix('/music/song.flac')).toBe('/music/song.flac');
    });

    it('strips a matching replace prefix', () => {
        expect(replacePathPrefix('/music/song.flac', '/music')).toBe('/song.flac');
    });

    it('does not strip a non-matching replace prefix', () => {
        expect(replacePathPrefix('/music/song.flac', '/other')).toBe('/music/song.flac');
    });

    it('prepends the add prefix', () => {
        expect(replacePathPrefix('/song.flac', undefined, '/media')).toBe('/media/song.flac');
    });

    it('strips then prepends when both prefixes are given', () => {
        expect(replacePathPrefix('/music/song.flac', '/music', '/media')).toBe('/media/song.flac');
    });
});

describe('sortSongsByFetchedOrder', () => {
    const song = (id: string, track: number) =>
        ({
            albumArtists: [],
            artists: [],
            discNumber: 1,
            genres: [],
            id,
            trackNumber: track,
        }) as unknown as Song;

    // Pinned songs / play-by-id promise the caller's id order; the SONG case
    // used to fall through unmatched and the tail re-sort by disc/track
    // silently discarded it (review matrix, 2026-06-11).
    it('preserves the requested id order for explicit song ids', () => {
        const songs = [song('a', 5), song('b', 1), song('c', 3)];
        const result = sortSongsByFetchedOrder(songs, ['c', 'a', 'b'], LibraryItem.SONG);
        expect(result.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    });
});

// Client-side sorts used by the Subsonic controller and the artist discography.
// They must key on fields that exist on the domain types; a key that is absent
// on every row makes the sort a silent no-op.
describe('sortAlbumList', () => {
    const album = (name: string, overrides: Partial<Album> = {}) =>
        ({ albumArtistName: '', name, userFavorite: false, ...overrides }) as Album;

    it('sorts by album artist name, then album name', () => {
        const albums = [
            album('B', { albumArtistName: 'Zed' }),
            album('C', { albumArtistName: 'abba' }),
            album('A', { albumArtistName: 'Zed' }),
        ];
        const result = sortAlbumList(albums, AlbumListSort.ALBUM_ARTIST, SortOrder.ASC);
        expect(result.map((a) => a.name)).toEqual(['C', 'A', 'B']);
    });

    it('puts favorites first when sorting by favorited descending', () => {
        const albums = [album('A'), album('B', { userFavorite: true }), album('C')];
        const result = sortAlbumList(albums, AlbumListSort.FAVORITED, SortOrder.DESC);
        expect(result[0].name).toBe('B');
    });
});

describe('sortAlbumArtistList', () => {
    it('puts favorites first when sorting by favorited descending', () => {
        const artists = [
            { name: 'A', userFavorite: false },
            { name: 'B', userFavorite: true },
        ] as AlbumArtist[];
        const result = sortAlbumArtistList(artists, AlbumArtistListSort.FAVORITED, SortOrder.DESC);
        expect(result.map((a) => a.name)).toEqual(['B', 'A']);
    });
});

describe('sortSongList', () => {
    it('keeps each album together when sorting by artist', () => {
        const song = (id: string, album: string, trackNumber: number) =>
            ({ album, artistName: 'Artist', discNumber: 1, id, trackNumber }) as Song;
        const songs = [
            song('y1', 'Y', 1),
            song('x2', 'X', 2),
            song('x1', 'X', 1),
            song('y2', 'Y', 2),
        ];
        const result = sortSongList(songs, SongListSort.ARTIST, SortOrder.ASC);
        expect(result.map((s) => s.id)).toEqual(['x1', 'x2', 'y1', 'y2']);
    });
});
