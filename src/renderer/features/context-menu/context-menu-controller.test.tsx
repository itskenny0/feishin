import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { LibraryItem } from '/@/shared/types/domain-types';

vi.mock('/@/renderer/features/context-menu/menus/song-context-menu', async () => {
    const { ContextMenu } = await import('/@/shared/components/context-menu/context-menu');
    return {
        SongContextMenu: () => (
            <>
                <span data-testid="menu-instance" />
                <ContextMenu.Content>
                    <ContextMenu.Item>Play</ContextMenu.Item>
                </ContextMenu.Content>
            </>
        ),
    };
});

import { ContextMenuController } from './context-menu-controller';

describe('ContextMenuController', () => {
    it('unmounts the menu instance once it closes', async () => {
        render(
            <QueryClientProvider client={new QueryClient()}>
                <MemoryRouter>
                    <ContextMenuController.Root />
                </MemoryRouter>
            </QueryClientProvider>,
        );

        const event = { clientX: 10, clientY: 10, preventDefault: () => {} } as any;

        await act(async () => {
            void ContextMenuController.call({
                cmd: { items: [], type: LibraryItem.SONG },
                event,
            });
        });

        expect(screen.getAllByTestId('menu-instance')).toHaveLength(1);
        expect(screen.getByRole('menu')).toBeTruthy();

        await act(async () => {
            fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(screen.queryAllByTestId('menu-instance')).toHaveLength(0);
    });
});
