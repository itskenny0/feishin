// Pure-function tests for the server-payload -> Dexie-row mappers. These
// pin the projection of indexed columns (SortName lower-casing, GenreIds
// extraction, the albumArtist/album id promotions) and the documented
// fallbacks for missing fields.

import type {
    Album,
    AlbumArtist,
    Artist,
    Genre,
    Playlist,
    Song,
} from '/@/shared/types/domain-types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    toCachedAlbumRow,
    toCachedArtistRow,
    toCachedGenreRow,
    toCachedPlaylistRow,
    toCachedSongRow,
} from '/@/renderer/cache/row-mappers';

const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
});

const album = (overrides: Partial<Album> = {}): Album =>
    ({
        albumArtists: [{ id: 'aa1', name: 'Artist One' }],
        genres: [
            { id: 'g1', name: 'Rock' },
            { id: 'g2', name: 'Pop' },
        ],
        id: 'al1',
        name: 'My Album',
        releaseYear: 1999,
        sortName: 'my album sort',
        updatedAt: '2020-01-01',
        ...overrides,
    }) as Album;

describe('toCachedAlbumRow', () => {
    it('promotes the indexed columns from the payload', () => {
        const row = toCachedAlbumRow(album());
        expect(row.Id).toBe('al1');
        expect(row.AlbumArtistId).toBe('aa1');
        expect(row.GenreIds).toEqual(['g1', 'g2']);
        expect(row.ProductionYear).toBe(1999);
        expect(row.SortName).toBe('my album sort');
        expect(row.DateLastSaved).toBe('2020-01-01');
        expect(row.__cachedAt).toBe(FIXED_NOW);
        expect(row.Payload).toEqual(album());
    });

    it('falls back to an empty album-artist id and empty genre list', () => {
        const row = toCachedAlbumRow(album({ albumArtists: undefined, genres: undefined }));
        expect(row.AlbumArtistId).toBe('');
        expect(row.GenreIds).toEqual([]);
    });

    it('derives SortName from the lower-cased name when sortName is absent', () => {
        const row = toCachedAlbumRow(album({ name: 'Mixed Case', sortName: undefined }));
        expect(row.SortName).toBe('mixed case');
    });

    it('uses undefined ProductionYear and empty DateLastSaved when missing', () => {
        const row = toCachedAlbumRow(album({ releaseYear: undefined, updatedAt: undefined }));
        expect(row.ProductionYear).toBeUndefined();
        expect(row.DateLastSaved).toBe('');
    });
});

describe('toCachedArtistRow', () => {
    const artist = (overrides: Partial<AlbumArtist> = {}): AlbumArtist =>
        ({
            id: 'ar1',
            name: 'The Band',
            ...overrides,
        }) as AlbumArtist;

    it('records the Kind and lower-cased SortName', () => {
        const row = toCachedArtistRow(artist(), 'AlbumArtist');
        expect(row.Id).toBe('ar1');
        expect(row.Kind).toBe('AlbumArtist');
        expect(row.Name).toBe('The Band');
        expect(row.SortName).toBe('the band');
        expect(row.__cachedAt).toBe(FIXED_NOW);
    });

    it('pulls updatedAt through when present and defaults to empty otherwise', () => {
        const withDate = toCachedArtistRow(
            { ...artist(), updatedAt: '2021-06-06' } as unknown as Artist,
            'Artist',
        );
        expect(withDate.Kind).toBe('Artist');
        expect(withDate.DateLastSaved).toBe('2021-06-06');

        const withoutDate = toCachedArtistRow(artist(), 'Artist');
        expect(withoutDate.DateLastSaved).toBe('');
    });
});

describe('toCachedSongRow', () => {
    const song = (overrides: Partial<Song> = {}): Song =>
        ({
            albumArtists: [{ id: 'aa2', name: 'Album Artist' }],
            albumId: 'al2',
            discNumber: 2,
            id: 's1',
            trackNumber: 7,
            updatedAt: '2022-02-02',
            ...overrides,
        }) as Song;

    it('promotes album / artist / track / disc columns', () => {
        const row = toCachedSongRow(song());
        expect(row.Id).toBe('s1');
        expect(row.AlbumId).toBe('al2');
        expect(row.AlbumArtistId).toBe('aa2');
        expect(row.IndexNumber).toBe(7);
        expect(row.ParentIndexNumber).toBe(2);
        expect(row.DateLastSaved).toBe('2022-02-02');
    });

    it('leaves the album-artist id undefined when there are no album artists', () => {
        const row = toCachedSongRow(song({ albumArtists: undefined }));
        expect(row.AlbumArtistId).toBeUndefined();
    });
});

describe('toCachedPlaylistRow', () => {
    const playlist = (overrides: Partial<Playlist> = {}): Playlist =>
        ({
            id: 'pl1',
            name: 'Road Trip',
            ...overrides,
        }) as Playlist;

    it('lower-cases the SortName and carries the non-canonical updatedAt', () => {
        const row = toCachedPlaylistRow({ ...playlist(), updatedAt: '2023-03-03' } as Playlist);
        expect(row.Id).toBe('pl1');
        expect(row.SortName).toBe('road trip');
        expect(row.DateLastSaved).toBe('2023-03-03');
    });

    it('defaults DateLastSaved to empty when updatedAt is absent', () => {
        const row = toCachedPlaylistRow(playlist());
        expect(row.DateLastSaved).toBe('');
    });
});

describe('toCachedGenreRow', () => {
    const genre = (overrides: Partial<Genre> = {}): Genre =>
        ({
            id: 'g9',
            name: 'Jazz Fusion',
            ...overrides,
        }) as Genre;

    it('lower-cases the SortName and copies the payload', () => {
        const row = toCachedGenreRow(genre());
        expect(row.Id).toBe('g9');
        expect(row.Name).toBe('Jazz Fusion');
        expect(row.SortName).toBe('jazz fusion');
        expect(row.Payload).toEqual(genre());
        expect(row.__cachedAt).toBe(FIXED_NOW);
    });
});
