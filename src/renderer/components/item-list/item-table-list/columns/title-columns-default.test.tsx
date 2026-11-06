// The non-song ("default") title-combined / title-artist table cells render
// album and playlist rows. They must read the album artist from
// `albumArtistName` (Album has no `albumArtist` field), and a playlist row
// (no `artists`) must still render its name instead of an empty cell.

import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { DefaultTitleArtistColumn } from '/@/renderer/components/item-list/item-table-list/columns/title-artist-column';
import { DefaultTitleCombinedColumn } from '/@/renderer/components/item-list/item-table-list/columns/title-combined-column';
import { LibraryItem } from '/@/shared/types/domain-types';
import { TableColumn } from '/@/shared/types/types';

vi.mock('/@/renderer/components/item-list/item-table-list/item-table-list-column', () => ({
    ColumnNullFallback: () => <div data-testid="null-fallback" />,
    ColumnSkeletonVariable: () => <div data-testid="skeleton" />,
    TableColumnContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('/@/renderer/components/item-image/item-image', () => ({ ItemImage: () => null }));
vi.mock('/@/renderer/store', () => ({ usePlayButtonBehavior: () => 'now' }));
vi.mock('/@/renderer/store/settings.store', () => ({
    useShowFilesystemNameForAlbums: () => false,
    useShowFilesystemNameForFolders: () => false,
}));

const album = (overrides: Record<string, unknown>) => ({
    _itemType: LibraryItem.ALBUM,
    _serverId: 's1',
    albumArtistName: '',
    albumArtists: [],
    artists: [],
    id: 'al1',
    imageId: null,
    imageUrl: null,
    name: 'Some Album',
    ...overrides,
});

const renderCell = (
    Cell: typeof DefaultTitleArtistColumn,
    item: Record<string, unknown>,
    itemType = LibraryItem.ALBUM,
) =>
    render(
        <MantineProvider>
            <MemoryRouter>
                <Cell
                    {...({
                        columnIndex: 0,
                        columns: [{ align: 'start', id: TableColumn.TITLE_COMBINED }],
                        controls: {},
                        data: [item],
                        getRowHeight: () => 40,
                        itemType,
                        rowIndex: 0,
                        size: 'default',
                    } as any)}
                />
            </MemoryRouter>
        </MantineProvider>,
    );

describe.each([
    ['DefaultTitleCombinedColumn', DefaultTitleCombinedColumn],
    ['DefaultTitleArtistColumn', DefaultTitleArtistColumn],
])('%s album rows', (_name, Cell) => {
    it('falls back to albumArtistName when the album has no related artists', () => {
        renderCell(Cell, album({ albumArtistName: 'Various Artists' }));
        expect(screen.getByText('Various Artists')).toBeInTheDocument();
    });

    it('links album artists by name (artist name inside the word "undefined")', () => {
        renderCell(
            Cell,
            album({ albumArtistName: 'Fine', albumArtists: [{ id: 'ar1', name: 'Fine' }] }),
        );
        expect(screen.getByText('Fine')).toBeInTheDocument();
    });
});

describe('DefaultTitleCombinedColumn playlist rows', () => {
    it('renders the playlist name (playlists have no artists)', () => {
        renderCell(
            DefaultTitleCombinedColumn,
            {
                _itemType: LibraryItem.PLAYLIST,
                _serverId: 's1',
                id: 'pl1',
                imageId: null,
                imageUrl: null,
                name: 'Road Trip',
                owner: 'me',
            },
            LibraryItem.PLAYLIST,
        );
        expect(screen.getByText('Road Trip')).toBeInTheDocument();
        expect(screen.queryByTestId('null-fallback')).not.toBeInTheDocument();
    });
});
