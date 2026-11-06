import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ addToQueueByData: vi.fn() }),
}));
vi.mock('/@/renderer/components/item-image/item-image', () => ({ ItemImage: () => null }));
vi.mock('/@/renderer/features/search/api/search-api', () => ({ searchQueries: {} }));

import { useFillSection } from '/@/renderer/features/search/components/unified-search-results';

const section = (
    pageCount: number,
    overrides: Partial<Parameters<typeof useFillSection>[0]> = {},
) => ({
    data: { pages: Array.from({ length: pageCount }, () => ({})) },
    fetchNextPage: vi.fn(),
    hasNextPage: true,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    ...overrides,
});

describe('useFillSection', () => {
    it('fetches the second page of a section', () => {
        const query = section(1);
        renderHook(() => useFillSection(query));
        expect(query.fetchNextPage).toHaveBeenCalledTimes(1);
    });

    it('stops once the section is full even though more pages exist', () => {
        const query = section(2);
        renderHook(() => useFillSection(query));
        expect(query.fetchNextPage).not.toHaveBeenCalled();
    });

    it('does not retry in a loop after a next-page error', () => {
        const query = section(1, { isFetchNextPageError: true });
        renderHook(() => useFillSection(query));
        expect(query.fetchNextPage).not.toHaveBeenCalled();
    });
});
