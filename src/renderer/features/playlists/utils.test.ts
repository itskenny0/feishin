import { describe, expect, it } from 'vitest';

import {
    convertNDQueryToQueryGroup,
    convertQueryGroupToNDQuery,
    playlistSongsToAlbums,
} from '/@/renderer/features/playlists/utils';
import { Song } from '/@/shared/types/domain-types';
import { QueryBuilderGroup } from '/@/shared/types/types';

const song = (overrides: Partial<Song>): Song =>
    ({
        _serverId: 'srv',
        _serverType: 'jellyfin',
        album: 'Album A',
        albumArtistName: 'Artist',
        albumArtists: [],
        albumId: 'album-a',
        artists: [],
        comment: null,
        compilation: false,
        createdAt: '2020-01-01',
        explicitStatus: null,
        genres: [],
        id: 'song-1',
        imageId: null,
        imageUrl: null,
        lastPlayedAt: null,
        participants: null,
        path: null,
        releaseDate: null,
        releaseYear: 2020,
        tags: null,
        updatedAt: '2020-01-02',
        ...overrides,
    }) as unknown as Song;

describe('playlistSongsToAlbums', () => {
    it('returns an empty array for no songs', () => {
        expect(playlistSongsToAlbums([])).toEqual([]);
    });

    it('collapses consecutive songs sharing an albumId into one album row', () => {
        const songs = [
            song({ albumId: 'a', id: '1' }),
            song({ albumId: 'a', id: '2' }),
            song({ album: 'Album B', albumId: 'b', id: '3' }),
        ];

        const rows = playlistSongsToAlbums(songs);

        expect(rows).toHaveLength(2);
        expect(rows[0].id).toBe('a');
        expect(rows[0]._playlistSongs).toHaveLength(2);
        expect(rows[1].id).toBe('b');
        expect(rows[1]._playlistSongs).toHaveLength(1);
    });

    it('does not merge identical albumIds that are not adjacent (preserves playlist order)', () => {
        const songs = [
            song({ albumId: 'a', id: '1' }),
            song({ album: 'Album B', albumId: 'b', id: '2' }),
            song({ albumId: 'a', id: '3' }),
        ];

        const rows = playlistSongsToAlbums(songs);

        expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'a']);
    });

    it('derives the album folder path from a song file path', () => {
        const rows = playlistSongsToAlbums([
            song({ albumId: 'a', path: '/music/Artist/Album/track01.flac' }),
        ]);

        expect(rows[0].path).toBe('/music/Artist/Album');
    });

    it('handles a windows-style path separator', () => {
        const rows = playlistSongsToAlbums([
            song({ albumId: 'a', path: 'C:\\music\\Artist\\Album\\track01.flac' }),
        ]);

        expect(rows[0].path).toBe('C:/music/Artist/Album');
    });

    it('falls back to a null path when the song path has no folder', () => {
        const rows = playlistSongsToAlbums([song({ albumId: 'a', path: 'track01.flac' })]);
        expect(rows[0].path).toBeNull();
    });

    it('uses an empty string album name when the song album is null', () => {
        const rows = playlistSongsToAlbums([song({ album: null, albumId: 'a' })]);
        expect(rows[0].name).toBe('');
        expect(rows[0].sortName).toBe('');
    });
});

describe('convertQueryGroupToNDQuery / convertNDQueryToQueryGroup', () => {
    it('builds an ND query keyed by the root group type', () => {
        const filter: QueryBuilderGroup = {
            group: [],
            rules: [
                {
                    field: 'title',
                    operator: 'contains',
                    uniqueId: 'r1',
                    value: 'hello',
                },
            ],
            type: 'all',
            uniqueId: 'g1',
        };

        const nd = convertQueryGroupToNDQuery(filter) as Record<string, unknown[]>;

        expect(Object.keys(nd)).toEqual(['all']);
        expect(nd.all).toEqual([{ contains: { title: 'hello' } }]);
    });

    it('coerces "true"/"false" string values for boolean fields to booleans', () => {
        const filter: QueryBuilderGroup = {
            group: [],
            rules: [
                {
                    field: 'loved',
                    operator: 'is',
                    uniqueId: 'r1',
                    value: 'true',
                },
            ],
            type: 'any',
            uniqueId: 'g1',
        };

        const nd = convertQueryGroupToNDQuery(filter) as Record<string, unknown[]>;
        expect(nd.any).toEqual([{ is: { loved: true } }]);
    });

    it('round-trips a non-boolean rule back into a query group', () => {
        const nd = { all: [{ contains: { title: 'hello' } }] };

        const group = convertNDQueryToQueryGroup(nd);

        expect(group.type).toBe('all');
        expect(group.rules).toHaveLength(1);
        expect(group.rules[0].field).toBe('title');
        expect(group.rules[0].operator).toBe('contains');
        expect(group.rules[0].value).toBe('hello');
    });

    it('stringifies boolean ND values when converting back to a query group', () => {
        const nd = { any: [{ is: { loved: true } }] };

        const group = convertNDQueryToQueryGroup(nd);

        expect(group.rules[0].field).toBe('loved');
        expect(group.rules[0].value).toBe('true');
    });

    it('maps date "before"/"after" operators to their date-picker variants on the way back', () => {
        const nd = { all: [{ before: { releaseDate: '2020-01-01' } }] };

        const group = convertNDQueryToQueryGroup(nd);

        expect(group.rules[0].operator).toBe('beforeDate');
        expect(group.rules[0].value).toBe('2020-01-01');
    });

    it('keeps non-date "before" operators unchanged on the way back', () => {
        const nd = { all: [{ before: { track: 5 } }] };

        const group = convertNDQueryToQueryGroup(nd);

        expect(group.rules[0].operator).toBe('before');
        expect(group.rules[0].value).toBe(5);
    });

    it('recurses into nested all/any groups', () => {
        const nd = {
            all: [{ contains: { title: 'a' } }, { any: [{ contains: { artist: 'b' } }] }],
        };

        const group = convertNDQueryToQueryGroup(nd);

        expect(group.rules).toHaveLength(1);
        expect(group.group).toHaveLength(1);
        expect(group.group[0].type).toBe('any');
        expect(group.group[0].rules[0].field).toBe('artist');
    });
});
