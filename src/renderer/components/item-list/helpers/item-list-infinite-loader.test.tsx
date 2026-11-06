// Regression test: the infinite-loader's item accessors must rotate their
// function identity whenever `dataVersion` advances.
//
// Why this matters (playlists table froze as skeletons, device 2026-06-10):
// the backing item map is mutated IN PLACE, so `getItem` is an impure read.
// This app is built with the React Compiler, which auto-memoizes the
// `item = getRowItem(rowIndex)` derivation inside every cell keyed on the
// accessor's identity. An identity-STABLE accessor is invisible to the
// compiler's dependency tracking: a cell that mounted before its page landed
// re-renders on the version bump (via useSyncExternalStore) yet reuses the
// stale memoized `item` (undefined → frozen skeleton). Tying the accessor
// identity to `dataVersion` makes the freshly-written page a tracked
// dependency so the compiler recomputes `item`.
//
// NOTE: vitest runs source through esbuild, NOT the babel React Compiler, so
// the freeze itself can't be reproduced here. We instead lock down the
// invariant the fix depends on — accessor identity advances with the version.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/renderer/cache', () => ({
    applyListPageToCache: vi.fn(),
    entityForLibraryItem: vi.fn(() => 'playlist'),
    preloadThumbnailUrls: vi.fn(() => Promise.resolve()),
    prepareExplicitRefresh: vi.fn(),
    shouldRevalidateFromNetwork: vi.fn(() => false),
}));

import { useItemListInfiniteLoader } from '/@/renderer/components/item-list/helpers/item-list-infinite-loader';
import { ListContext } from '/@/renderer/context/list-context';
import { LibraryItem } from '/@/shared/types/domain-types';

const makeWrapper = () => {
    const queryClient = new QueryClient({
        defaultOptions: { queries: { gcTime: 0, retry: false } },
    });
    return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
            <ListContext.Provider value={{ pageKey: 'test' }}>{children}</ListContext.Provider>
        </QueryClientProvider>
    );
};

const renderLoader = () => {
    // A resolved-data count query keeps the suspense boundary out of the way.
    const listCountQuery = {
        queryFn: () => Promise.resolve(3),
        queryKey: ['srv', 'count', LibraryItem.PLAYLIST] as const,
    } as any;

    const listQueryFn = vi.fn(async ({ query }: { query: { startIndex: number } }) => ({
        items: [
            {
                _itemType: LibraryItem.PLAYLIST,
                id: `id-${query.startIndex}`,
                name: `Row ${query.startIndex}`,
            },
        ],
    }));

    return renderHook(
        () =>
            useItemListInfiniteLoader({
                eventKey: 'PLAYLIST',
                itemsPerPage: 1,
                itemType: LibraryItem.PLAYLIST,
                listCountQuery,
                listQueryFn,
                query: { sortBy: 'name' },
                serverId: 'srv',
            }),
        { wrapper: makeWrapper() },
    );
};

describe('useItemListInfiniteLoader accessor identity', () => {
    it('rotates getItem / getItemIndex identity when a page write advances dataVersion', async () => {
        const { result } = renderLoader();

        // Let the suspense-driven initial fetch settle.
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        const v0 = result.current.dataVersion;
        const getItem0 = result.current.getItem;
        const getItemIndex0 = result.current.getItemIndex;

        // Simulate a page landing: drive a range change so the loader writes a
        // page and bumps the version.
        await act(async () => {
            await result.current.onRangeChanged({ startIndex: 2, stopIndex: 2 });
            await new Promise((r) => setTimeout(r, 50));
        });

        expect(result.current.dataVersion).toBeGreaterThan(v0);
        // The load-bearing invariant: a new version => new accessor identities,
        // so the React-Compiler-memoized `item` derivation in every cell
        // invalidates and re-reads the (mutated-in-place) map.
        expect(result.current.getItem).not.toBe(getItem0);
        expect(result.current.getItemIndex).not.toBe(getItemIndex0);
    });
});

describe('useItemListInfiniteLoader visible range', () => {
    it('fetches every unloaded page the visible range spans', async () => {
        const listQueryFn = vi.fn(async ({ query }: { query: { startIndex: number } }) => ({
            items: Array.from({ length: 10 }, (_, i) => ({
                _itemType: LibraryItem.ALBUM,
                id: `span-${query.startIndex + i}`,
            })),
        }));

        const { result } = renderHook(
            () =>
                useItemListInfiniteLoader({
                    eventKey: 'ALBUM',
                    itemsPerPage: 10,
                    itemType: LibraryItem.ALBUM,
                    listCountQuery: {
                        queryFn: () => Promise.resolve(40),
                        queryKey: ['srv', 'count', 'span'],
                    } as any,
                    listQueryFn: listQueryFn as any,
                    query: { searchTerm: 'span' },
                    serverId: 'srv',
                }),
            { wrapper: makeWrapper() },
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        // A jump (scrollbar drag, scroll restore) to rows 15-25: pages 1 and 2
        // are both on screen and neither is loaded.
        await act(async () => {
            await result.current.onRangeChanged({ startIndex: 15, stopIndex: 25 });
            await new Promise((r) => setTimeout(r, 50));
        });

        expect(result.current.getItem(15)).toMatchObject({ id: 'span-15' });
        expect(result.current.getItem(25)).toMatchObject({ id: 'span-25' });
    });
});

describe('useItemListInfiniteLoader query change', () => {
    it('does not write a late page from the previous query into the new query', async () => {
        const items = (term: string, startIndex: number) =>
            Array.from({ length: 10 }, (_, i) => ({
                _itemType: LibraryItem.ALBUM,
                id: `${term}-${startIndex + i}`,
            }));

        let releaseStalePage: () => void = () => {};
        const listQueryFn = vi.fn(
            ({ query }: { query: { searchTerm: string; startIndex: number } }) => {
                const page = { items: items(query.searchTerm, query.startIndex) };
                if (query.searchTerm === 'late-a' && query.startIndex === 10) {
                    return new Promise<typeof page>((resolve) => {
                        releaseStalePage = () => resolve(page);
                    });
                }
                return Promise.resolve(page);
            },
        );

        const { rerender, result } = renderHook(
            ({ searchTerm }: { searchTerm: string }) =>
                useItemListInfiniteLoader({
                    eventKey: 'ALBUM',
                    itemsPerPage: 10,
                    itemType: LibraryItem.ALBUM,
                    listCountQuery: {
                        queryFn: () => Promise.resolve(30),
                        queryKey: ['srv', 'count', searchTerm],
                    } as any,
                    listQueryFn: listQueryFn as any,
                    query: { searchTerm },
                    serverId: 'srv',
                }),
            { initialProps: { searchTerm: 'late-a' }, wrapper: makeWrapper() },
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });

        // Scroll into page 1 of query A; its fetch stays in flight.
        act(() => {
            void result.current.onRangeChanged({ startIndex: 12, stopIndex: 15 });
        });

        // The query changes (e.g. the search term); B's page 1 lands first.
        rerender({ searchTerm: 'late-b' });
        await act(async () => {
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(result.current.getItem(10)).toMatchObject({ id: 'late-b-10' });

        // A's stale response must not overwrite B's rows.
        await act(async () => {
            releaseStalePage();
            await new Promise((r) => setTimeout(r, 50));
        });
        expect(result.current.getItem(10)).toMatchObject({ id: 'late-b-10' });
    });
});
