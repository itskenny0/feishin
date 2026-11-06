import { describe, expect, it } from 'vitest';

import { songCoverId } from '/@/shared/utils/song-cover-id';

describe('songCoverId', () => {
    it('keys a song with distinct own art on its own imageId', () => {
        expect(songCoverId({ albumId: 'album-1', hasOwnCover: true, imageId: 'song-1' })).toBe(
            'song-1',
        );
    });

    it('keys a song without distinct art on its album', () => {
        expect(songCoverId({ albumId: 'album-1', imageId: 'song-1' })).toBe('album-1');
        expect(songCoverId({ albumId: 'album-1', hasOwnCover: false, imageId: 'song-1' })).toBe(
            'album-1',
        );
    });

    it('falls back to the album when hasOwnCover is set but there is no imageId', () => {
        expect(songCoverId({ albumId: 'album-1', hasOwnCover: true, imageId: null })).toBe(
            'album-1',
        );
    });

    it('falls back to the imageId when there is no albumId', () => {
        expect(songCoverId({ albumId: null, imageId: 'cover-1' })).toBe('cover-1');
        expect(songCoverId({ imageId: 'cover-1' })).toBe('cover-1');
    });

    it('returns undefined for a missing item or one with no cover ids', () => {
        expect(songCoverId(undefined)).toBeUndefined();
        expect(songCoverId(null)).toBeUndefined();
        expect(songCoverId({ albumId: null, imageId: null })).toBeUndefined();
    });
});
