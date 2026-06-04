// Regression test for the genre context menu wiring.
//
// Bug: GenreContextMenu used to pass `itemType={LibraryItem.ALBUM}` to both
// PlayAction and AddToPlaylistAction even though the selected ids are GENRE
// ids. Downstream, fetchSongsByItemType / sortSongsByFetchedOrder /
// AddToPlaylistAction all have dedicated GENRE branches, so feeding them
// ALBUM meant genre ids were resolved as album ids -> wrong/empty playback
// and broken "add to playlist". This test pins the itemType passed to the
// child actions to LibraryItem.GENRE.
//
// We mock the action child components so we can capture their props without
// dragging in the player store / query client / i18n bootstrap.

import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { LibraryItem } from '/@/shared/types/domain-types';

const captured: { addToPlaylist?: any; play?: any } = {};

vi.mock('/@/renderer/features/context-menu/actions/play-action', () => ({
    PlayAction: (props: any) => {
        captured.play = props;
        return null;
    },
}));
vi.mock('/@/renderer/features/context-menu/actions/add-to-playlist-action', () => ({
    AddToPlaylistAction: (props: any) => {
        captured.addToPlaylist = props;
        return null;
    },
}));
vi.mock('/@/renderer/features/context-menu/actions/offline-download-action', () => ({
    OfflineDownloadAction: () => null,
}));
vi.mock('/@/renderer/features/context-menu/components/context-menu-preview', () => ({
    ContextMenuPreview: () => null,
}));
vi.mock('/@/renderer/features/context-menu/components/menu-content', () => ({
    MenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('/@/shared/components/context-menu/context-menu', () => ({
    ContextMenu: Object.assign(() => null, { Divider: () => null }),
}));

import { GenreContextMenu } from './genre-context-menu';

describe('GenreContextMenu', () => {
    it('passes GENRE itemType (not ALBUM) and the genre ids to play + add-to-playlist', () => {
        const items = [
            { id: 'genre-1', name: 'Rock' },
            { id: 'genre-2', name: 'Jazz' },
        ] as any;

        render(<GenreContextMenu items={items} type={LibraryItem.GENRE} />);

        expect(captured.play.itemType).toBe(LibraryItem.GENRE);
        expect(captured.play.ids).toEqual(['genre-1', 'genre-2']);

        expect(captured.addToPlaylist.itemType).toBe(LibraryItem.GENRE);
        expect(captured.addToPlaylist.items).toEqual(['genre-1', 'genre-2']);
    });
});
