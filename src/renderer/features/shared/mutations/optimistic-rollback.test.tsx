import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { queryKeys } from '/@/renderer/api/query-keys';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { useCreateFavorite } from '/@/renderer/features/shared/mutations/create-favorite-mutation';
import { useSetRatingMutation } from '/@/renderer/features/shared/mutations/set-rating-mutation';
import { LibraryItem } from '/@/shared/types/domain-types';

vi.mock('/@/renderer/cache', () => ({
    enqueueMutation: vi.fn(() => Promise.reject(new Error('offline'))),
}));
vi.mock('/@/shared/components/toast/toast', () => ({ toast: { show: vi.fn() } }));

const S = 'server-1';
const listKey = [...queryKeys.songs.list(S), { q: 1 }];

// Mirrors the paginated list loader: it writes favorite / rating events into
// its own list query synchronously.
const patchListOnEvent = (qc: QueryClient) => (payload: any) =>
    qc.setQueryData(listKey, (prev: any) => ({
        ...prev,
        items: prev.items.map((item: any) =>
            payload.id.includes(item.id)
                ? {
                      ...item,
                      ...('rating' in payload
                          ? { userRating: payload.rating }
                          : { userFavorite: payload.favorite }),
                  }
                : item,
        ),
    }));

const setup = () => {
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    qc.setQueryData(listKey, { items: [{ id: 's1', userFavorite: false, userRating: 2 }] });
    const listener = patchListOnEvent(qc);
    eventEmitter.on('USER_RATING', listener);
    eventEmitter.on('USER_FAVORITE', listener);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const cleanup = () => {
        eventEmitter.off('USER_RATING', listener);
        eventEmitter.off('USER_FAVORITE', listener);
    };
    return { cleanup, qc, wrapper };
};

let cleanup = () => {};
afterEach(() => cleanup());

describe('optimistic favorite / rating rollback', () => {
    it('restores the previous rating in list queries when the mutation fails', async () => {
        const ctx = setup();
        cleanup = ctx.cleanup;
        const { result } = renderHook(() => useSetRatingMutation({}), { wrapper: ctx.wrapper });

        act(() => {
            result.current.mutate({
                apiClientProps: { serverId: S },
                query: { id: ['s1'], rating: 5, type: LibraryItem.SONG },
            });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(ctx.qc.getQueryData<any>(listKey).items[0].userRating).toBe(2);
    });

    it('restores the previous favorite in list queries when the mutation fails', async () => {
        const ctx = setup();
        cleanup = ctx.cleanup;
        const { result } = renderHook(() => useCreateFavorite({}), { wrapper: ctx.wrapper });

        act(() => {
            result.current.mutate({
                apiClientProps: { serverId: S },
                query: { id: ['s1'], type: LibraryItem.SONG },
            });
        });

        await waitFor(() => expect(result.current.isError).toBe(true));
        expect(ctx.qc.getQueryData<any>(listKey).items[0].userFavorite).toBe(false);
    });
});
