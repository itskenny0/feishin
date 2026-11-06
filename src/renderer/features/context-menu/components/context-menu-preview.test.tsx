import { MantineProvider } from '@mantine/core';
import { render as rtlRender } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ContextMenuPreview } from '/@/renderer/features/context-menu/components/context-menu-preview';
import { LibraryItem } from '/@/shared/types/domain-types';

// Covers render cache-only, keyed like the thumbnail sweep: songs share their
// album's cover row (albumId ?? imageId), never the song id.
const cachedImage = vi.fn();

vi.mock('/@/renderer/cache', () => ({
    CachedImage: (props: { itemId: string }) => {
        cachedImage(props);
        return null;
    },
}));
vi.mock('/@/renderer/components/item-image/item-image', () => ({
    useItemImageUrl: () => 'https://server/cover.jpg',
}));
vi.mock('/@/renderer/store', () => ({ useImagePlaceholderPriority: () => 'blurhash' }));
vi.mock('/@/renderer/store/settings.store', () => ({
    useShowFilesystemNameForAlbums: () => false,
    useShowFilesystemNameForFolders: () => false,
}));
vi.mock('/@/shared/hooks/use-image-hash-url', () => ({ useImageHashUrl: () => null }));

const render = (ui: React.ReactElement) => rtlRender(<MantineProvider>{ui}</MantineProvider>);
const renderedItemId = () => cachedImage.mock.calls.at(-1)?.[0].itemId;

describe('ContextMenuPreview cover cache key', () => {
    beforeEach(() => cachedImage.mockClear());

    it.each([LibraryItem.SONG, LibraryItem.PLAYLIST_SONG, LibraryItem.QUEUE_SONG])(
        'keys a %s cover on its albumId',
        (itemType) => {
            const song = { albumId: 'album-1', id: 'song-1', imageId: 'cover-1', name: 'Song' };
            render(<ContextMenuPreview items={[song]} itemType={itemType} />);
            expect(renderedItemId()).toBe('album-1');
        },
    );

    it('falls back to the imageId for a song without an albumId', () => {
        const song = { albumId: null, id: 'song-1', imageId: 'cover-1', name: 'Song' };
        render(<ContextMenuPreview items={[song]} itemType={LibraryItem.SONG} />);
        expect(renderedItemId()).toBe('cover-1');
    });

    it('keys non-song covers on the item id', () => {
        const album = { id: 'album-1', imageId: 'album-1', name: 'Album' };
        render(<ContextMenuPreview items={[album]} itemType={LibraryItem.ALBUM} />);
        expect(renderedItemId()).toBe('album-1');
    });
});
