// REGRESSION: opening the command palette from the mobile bottom tab bar
// stopped popping the soft keyboard. The input carries `data-autofocus`,
// which only works inside a Mantine focus trap — and the palette became a
// routed PAGE (/command), so nothing ever focused the field. The palette
// must focus its search input explicitly on mount.

import { MantineProvider } from '@mantine/core';
import { act, render } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { useInfiniteQuery } = vi.hoisted(() => ({
    useInfiniteQuery: vi.fn((_options: { enabled?: boolean; queryKey: unknown[] }) => ({
        data: undefined,
        isFetching: false,
    })),
}));

vi.mock('react-router', () => ({
    createSearchParams: () => new URLSearchParams(),
    generatePath: (p: string) => p,
    useNavigate: () => vi.fn(),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    useInfiniteQuery,
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
                    pages={[]}
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

describe('MobileSearchPalette search debounce', () => {
    it('does not search until typing pauses for 400ms', async () => {
        vi.useFakeTimers();
        const props = {
            handleClose: vi.fn(),
            onSelectResult: vi.fn(),
            pages: [],
            searchInputRef: createRef<HTMLInputElement>(),
            setPages: vi.fn(),
            setQuery: vi.fn(),
        };
        const view = (query: string) => (
            <MantineProvider>
                <MobileSearchPalette {...props} query={query} />
            </MantineProvider>
        );
        // The search term is part of every section's query key.
        const searchedTerms = () =>
            new Set(useInfiniteQuery.mock.calls.map(([options]) => options.queryKey.at(-1)));

        const { rerender } = render(view(''));
        rerender(view('r'));
        rerender(view('ra'));
        rerender(view('rad'));
        expect(searchedTerms()).toEqual(new Set([''])); // nothing searched while typing

        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(searchedTerms()).toEqual(new Set(['', 'rad']));
        vi.useRealTimers();
    });
});
