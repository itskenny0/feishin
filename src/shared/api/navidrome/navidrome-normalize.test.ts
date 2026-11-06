// Pure-function tests for the Navidrome native-API normalizer.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ndNormalize } from '/@/shared/api/navidrome/navidrome-normalize';
import { ndType } from '/@/shared/api/navidrome/navidrome-types';

type NdAlbum = z.infer<typeof ndType._response.album>;

const baseAlbum = (overrides: Partial<NdAlbum> = {}): NdAlbum =>
    ({
        albumArtist: 'Artist',
        albumArtistId: 'ar1',
        artist: 'Artist',
        artistId: 'ar1',
        compilation: false,
        createdAt: '2020-01-01T00:00:00Z',
        externalInfoUpdatedAt: null,
        genre: '',
        genres: null,
        id: 'al1',
        libraryId: 1,
        libraryName: 'Music',
        libraryPath: '/music',
        maxYear: 0,
        minYear: 0,
        name: 'Album',
        orderAlbumArtistName: 'artist',
        orderAlbumName: 'album',
        size: 1,
        songCount: 1,
        updatedAt: '2020-01-01T00:00:00Z',
        ...overrides,
    }) as NdAlbum;

describe('ndNormalize.album dates', () => {
    it('prefers releaseDate, then date, then minYear for the release date', () => {
        const pick = (album: NdAlbum) => {
            const { releaseDate, releaseYear } = ndNormalize.album(album);
            return [releaseDate, releaseYear];
        };
        expect(pick(baseAlbum({ date: '2001', minYear: 1999, releaseDate: '2002-03' }))).toEqual([
            '2002-03',
            2002,
        ]);
        expect(pick(baseAlbum({ date: '2001-05-06', minYear: 1999 }))).toEqual([
            '2001-05-06',
            2001,
        ]);
        expect(pick(baseAlbum({ date: 'garbage', minYear: 1999 }))).toEqual(['1999', 1999]);
        expect(pick(baseAlbum())).toEqual([null, null]);
    });

    it('prefers originalDate, then the release fields, then the original year', () => {
        const pick = (album: NdAlbum) => {
            const { originalDate, originalYear } = ndNormalize.album(album);
            return [originalDate, originalYear];
        };
        expect(pick(baseAlbum({ originalDate: '1970', releaseDate: '2002' }))).toEqual([
            '1970',
            1970,
        ]);
        expect(pick(baseAlbum({ date: '2001', releaseDate: '2002' }))).toEqual(['2002', 2002]);
        expect(pick(baseAlbum({ minOriginalYear: 1965, minYear: 1999 }))).toEqual(['1965', 1965]);
        expect(pick(baseAlbum({ minYear: 1999 }))).toEqual(['1999', 1999]);
        expect(pick(baseAlbum())).toEqual([null, null]);
    });
});

describe('ndNormalize.album fields', () => {
    it('maps explicit status codes', () => {
        expect(ndNormalize.album(baseAlbum({ explicitStatus: 'e' })).explicitStatus).toBe(
            'EXPLICIT',
        );
        expect(ndNormalize.album(baseAlbum({ explicitStatus: 'c' })).explicitStatus).toBe('CLEAN');
        expect(ndNormalize.album(baseAlbum({ explicitStatus: '' })).explicitStatus).toBeNull();
    });

    it('maps genres and splits record labels / release types out of the tags', () => {
        const album = ndNormalize.album(
            baseAlbum({
                genres: [{ id: 'g1', name: 'Rock' }],
                tags: {
                    genre: ['Rock'],
                    mood: ['calm'],
                    recordlabel: ['Label'],
                    releasetype: ['ep'],
                },
            }),
        );
        expect(album.genres.map((g) => [g.id, g.name])).toEqual([['g1', 'Rock']]);
        expect(album.recordLabels).toEqual(['Label']);
        expect(album.releaseTypes).toEqual(['ep']);
        expect(album.tags).toEqual({ mood: ['calm'] });
        expect(ndNormalize.album(baseAlbum()).tags).toBeNull();
    });
});
