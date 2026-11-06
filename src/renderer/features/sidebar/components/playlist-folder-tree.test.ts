import { describe, expect, it } from 'vitest';

import { remapPlaylistFolderPath } from '/@/renderer/features/sidebar/components/playlist-folder-tree';

describe('remapPlaylistFolderPath', () => {
    it('nests a root-level folder under an unrelated folder', () => {
        expect(remapPlaylistFolderPath('Classic/x', 'Classic', 'Rock', '/')).toBe('Rock/Classic/x');
    });

    it('moves a nested folder onto a sibling by its own name', () => {
        expect(remapPlaylistFolderPath('Rock/Classic/x', 'Rock/Classic', 'Rock/Modern', '/')).toBe(
            'Rock/Modern/Classic/x',
        );
    });

    it('moves a nested folder onto an unrelated folder by its own name', () => {
        expect(remapPlaylistFolderPath('Pop/Classic/a/x', 'Pop/Classic', 'Rock', '/')).toBe(
            'Rock/Classic/a/x',
        );
    });

    it('flattens a folder dropped onto its direct parent', () => {
        expect(remapPlaylistFolderPath('Rock/Classic/x', 'Rock/Classic', 'Rock', '/')).toBe(
            'Rock/x',
        );
    });

    it('moves a folder onto a higher ancestor as a unit', () => {
        expect(remapPlaylistFolderPath('Pop/Rock/Classic/x', 'Pop/Rock/Classic', 'Pop', '/')).toBe(
            'Pop/Classic/x',
        );
    });

    it('ignores playlists outside the source folder', () => {
        expect(remapPlaylistFolderPath('Rocky/x', 'Rock', 'Pop', '/')).toBeNull();
    });
});
