import { describe, expect, it } from 'vitest';

import { albumFolderFromSongPath } from '/@/shared/utils/album-folder-from-path';

describe('albumFolderFromSongPath', () => {
    it('returns null for nullish or empty input', () => {
        expect(albumFolderFromSongPath()).toBeNull();
        expect(albumFolderFromSongPath(null)).toBeNull();
        expect(albumFolderFromSongPath('')).toBeNull();
    });

    it('returns null when the path is too shallow', () => {
        expect(albumFolderFromSongPath('track.flac')).toBeNull();
        expect(albumFolderFromSongPath('/track.flac')).toBeNull();
    });

    it('uses the immediate parent directory as the album folder', () => {
        expect(albumFolderFromSongPath('/Music/Artist/Album/01 - Track.flac')).toBe('Album');
    });

    it('handles Windows separators', () => {
        expect(albumFolderFromSongPath('C:\\Music\\Artist\\Album\\01 - Track.flac')).toBe('Album');
    });

    it('walks up past disc folders to the album name', () => {
        expect(albumFolderFromSongPath('/Music/Artist/Album/Disc 1/01.flac')).toBe('Album');
        expect(albumFolderFromSongPath('/Music/Artist/Album/CD2/05 - Foo.flac')).toBe('Album');
        expect(albumFolderFromSongPath('/Music/Artist/Album/Disk 3/01.flac')).toBe('Album');
        expect(albumFolderFromSongPath('/Music/Artist/Album/Vol. 2/01.flac')).toBe('Album');
        expect(albumFolderFromSongPath('/Music/Artist/Album/Volume 2/01.flac')).toBe('Album');
    });

    it('is case-insensitive for the disc-folder pattern', () => {
        expect(albumFolderFromSongPath('/Music/Artist/Album/disc 1/01.flac')).toBe('Album');
        expect(albumFolderFromSongPath('/Music/Artist/Album/CD 10/01.flac')).toBe('Album');
    });

    it('falls back to the disc folder when there is no level above it', () => {
        expect(albumFolderFromSongPath('Disc 1/01.flac')).toBe('Disc 1');
    });

    it('does not treat non-disc parents as disc folders', () => {
        expect(albumFolderFromSongPath('/Music/Artist/Discography/01.flac')).toBe('Discography');
        expect(albumFolderFromSongPath('/Music/Artist/CDs/01.flac')).toBe('CDs');
    });

    it('ignores trailing and repeated separators', () => {
        expect(albumFolderFromSongPath('/Music//Artist///Album/01.flac')).toBe('Album');
    });
});
