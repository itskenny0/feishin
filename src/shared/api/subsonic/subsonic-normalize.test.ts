// Pure-function tests for the Subsonic / OpenSubsonic response normalizer.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ssNormalize } from '/@/shared/api/subsonic/subsonic-normalize';
import { ssType } from '/@/shared/api/subsonic/subsonic-types';

type SsAlbum = z.infer<typeof ssType._response.album>;

const baseAlbum = (overrides: Partial<SsAlbum> = {}): SsAlbum =>
    ({
        album: 'Album',
        artist: 'Artist',
        artistId: 'ar1',
        artists: [],
        coverArt: 'al-1',
        created: '2020-01-01T00:00:00.000Z',
        duration: 60,
        id: 'al1',
        isDir: true,
        isVideo: false,
        name: 'Album',
        parent: 'p1',
        song: [],
        songCount: 0,
        title: 'Album',
        ...overrides,
    }) as SsAlbum;

describe('ssNormalize.album', () => {
    // OpenSubsonic AlbumID3 carries `isCompilation`; the album detail tags and
    // the artist page "Compilations" grouping both read Album.isCompilation.
    it('maps the OpenSubsonic isCompilation flag', () => {
        expect(ssNormalize.album(baseAlbum({ isCompilation: true })).isCompilation).toBe(true);
        expect(ssNormalize.album(baseAlbum({ isCompilation: false })).isCompilation).toBe(false);
    });

    it('leaves isCompilation unknown when the server does not report it', () => {
        expect(ssNormalize.album(baseAlbum()).isCompilation).toBeNull();
    });

    it('prefers the OpenSubsonic genres array over the legacy genre string', () => {
        const names = (album: SsAlbum) => ssNormalize.album(album).genres.map((g) => g.id);
        expect(names(baseAlbum({ genre: 'Rock', genres: [{ name: 'Jazz' }] }))).toEqual(['Jazz']);
        expect(names(baseAlbum({ genre: 'Rock' }))).toEqual(['Rock']);
        expect(names(baseAlbum({ genre: 'Rock', genres: [] }))).toEqual([]);
        expect(names(baseAlbum())).toEqual([]);
    });

    it('maps the explicit status', () => {
        expect(ssNormalize.album(baseAlbum({ explicitStatus: 'explicit' })).explicitStatus).toBe(
            'EXPLICIT',
        );
        expect(ssNormalize.album(baseAlbum({ explicitStatus: 'clean' })).explicitStatus).toBe(
            'CLEAN',
        );
        expect(ssNormalize.album(baseAlbum({ explicitStatus: '' })).explicitStatus).toBeNull();
    });
});
