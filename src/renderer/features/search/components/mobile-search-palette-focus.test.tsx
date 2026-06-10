// REGRESSION: opening the command palette from the mobile bottom tab bar
// stopped popping the soft keyboard. The input carries `data-autofocus`,
// which only works inside a Mantine focus trap — and the palette became a
// routed PAGE (/command), so nothing ever focused the field. The palette
// must focus its search input explicitly on mount.

import { MantineProvider } from '@mantine/core';
import { render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router', () => ({
    createSearchParams: () => new URLSearchParams(),
    generatePath: (p: string) => p,
    useNavigate: () => vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useInfiniteQuery: () => ({ data: undefined, isFetching: false }),
}));
vi.mock('@mantine/modals', () => ({ closeAllModals: vi.fn(), openModal: vi.fn() }));
vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ addToQueueByData: vi.fn(), addToQueueByFetch: vi.fn() }),
}));

import { MobileSearchPalette } from '/@/renderer/features/search/components/mobile-search-palette';

describe('MobileSearchPalette mount focus', () => {
    it('focuses the search input on mount so the soft keyboard pops', () => {
        const searchInputRef = createRef<HTMLInputElement>();
        render(
            <MantineProvider>
                <MobileSearchPalette
                    handleClose={vi.fn()}
                    onSelectResult={vi.fn()}
                    query=""
                    searchInputRef={searchInputRef}
                    setPages={vi.fn()}
                    setQuery={vi.fn()}
                />
            </MantineProvider>,
        );

        expect(searchInputRef.current).toBeTruthy();
        expect(document.activeElement).toBe(searchInputRef.current);
    });
});
