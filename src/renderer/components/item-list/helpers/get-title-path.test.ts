/**
 * Unit coverage for getTitlePath — maps a library item type + id to the
 * in-app detail route, or null for types that have no detail page (e.g. raw
 * songs / folders). Guards against route-pattern drift breaking title links.
 */
import { describe, expect, it } from 'vitest';

import { getTitlePath } from '/@/renderer/components/item-list/helpers/get-title-path';
import { LibraryItem } from '/@/shared/types/domain-types';

describe('getTitlePath', () => {
    it('builds the album detail path', () => {
        expect(getTitlePath(LibraryItem.ALBUM, 'a1')).toBe('/library/albums/a1');
    });

    it('builds the album-artist detail path', () => {
        expect(getTitlePath(LibraryItem.ALBUM_ARTIST, 'aa1')).toBe('/library/album-artists/aa1');
    });

    it('builds the artist detail path', () => {
        expect(getTitlePath(LibraryItem.ARTIST, 'ar1')).toBe('/library/artists/ar1');
    });

    it('builds the genre detail path', () => {
        expect(getTitlePath(LibraryItem.GENRE, 'g1')).toBe('/library/genres/g1');
    });

    it('builds the playlist songs detail path', () => {
        expect(getTitlePath(LibraryItem.PLAYLIST, 'p1')).toBe('/playlists/p1/songs');
    });

    it('returns null for item types with no detail route', () => {
        expect(getTitlePath(LibraryItem.SONG, 's1')).toBeNull();
        expect(getTitlePath(LibraryItem.FOLDER, 'f1')).toBeNull();
    });
});
