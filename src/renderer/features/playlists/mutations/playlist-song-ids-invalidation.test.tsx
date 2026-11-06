// Playlist edits go straight to the server, so each track mutation must:
// - invalidate the song-id list: the add-to-playlist "skip duplicates" check
//   reads it through queryClient.fetchQuery, which serves the cached list
//   while it is fresh (default staleTime 5 min), so a second add within the
//   window re-adds the same songs (and a remove leaves the removed songs
//   looking like duplicates);
// - drop the playlist's cached tracklist (and open the refresh window)
//   BEFORE invalidating: with sync-first on, the refetch otherwise reads the
//   pre-edit Dexie rows and never revalidates.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    deletedFor: [] as string[],
    order: [] as string[],
    prepareExplicitRefresh: vi.fn(),
}));

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            addToPlaylist: vi.fn(async () => null),
            removeFromPlaylist: vi.fn(async () => null),
            setPlaylistSongs: vi.fn(async () => null),
            updatePlaylist: vi.fn(async () => null),
        },
    },
}));
vi.mock('/@/renderer/api/controller', () => ({ controller: {} }));
vi.mock('/@/renderer/cache', () => ({
    getActiveCacheDb: () => ({
        playlistSongs: {
            where: () => ({
                equals: (id: string) => ({
                    delete: async () => {
                        mocks.deletedFor.push(id);
                        mocks.order.push('drop');
                    },
                }),
            }),
        },
    }),
    prepareExplicitRefresh: mocks.prepareExplicitRefresh,
}));
vi.mock('/@/renderer/store', () => ({ useCurrentServerId: () => 'server-1' }));
vi.mock('/@/renderer/features/playlists/hooks/use-recent-playlists', () => ({
    useRecentPlaylists: () => ({ addRecentPlaylist: vi.fn() }),
}));
vi.mock('/@/renderer/lib/react-query', () => ({}));

import { queryKeys } from '/@/renderer/api/query-keys';
import { useAddToPlaylist } from '/@/renderer/features/playlists/mutations/add-to-playlist-mutation';
import { useRemoveFromPlaylist } from '/@/renderer/features/playlists/mutations/remove-from-playlist-mutation';
import { useUpdatePlaylist } from '/@/renderer/features/playlists/mutations/update-playlist-mutation';
import { useUpdatePlaylistTracks } from '/@/renderer/features/playlists/mutations/update-playlist-tracks-mutation';

const idsKey = queryKeys.playlists.songListIds('server-1', 'playlist-1');

const setup = () => {
    mocks.deletedFor.length = 0;
    mocks.order.length = 0;
    mocks.prepareExplicitRefresh.mockClear();
    const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: 1000 * 60 * 5 } },
    });
    queryClient.setQueryData(idsKey, ['song-a']);
    const invalidate = queryClient.invalidateQueries.bind(queryClient);
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((...args) => {
        mocks.order.push('invalidate');
        return invalidate(...args);
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { queryClient, wrapper };
};

const expectCacheDroppedFirst = () => {
    expect(mocks.deletedFor).toEqual(['playlist-1']);
    expect(mocks.prepareExplicitRefresh).toHaveBeenCalledWith('playlists');
    expect(mocks.order[0]).toBe('drop');
};

describe('playlist track mutations', () => {
    it('add', async () => {
        const { queryClient, wrapper } = setup();
        const { result } = renderHook(() => useAddToPlaylist({}), { wrapper });
        await act(() =>
            result.current.mutateAsync({
                apiClientProps: { serverId: 'server-1' },
                body: { songId: ['song-b'] },
                query: { id: 'playlist-1' },
            }),
        );
        expect(queryClient.getQueryState(idsKey)?.isInvalidated).toBe(true);
        expectCacheDroppedFirst();
    });

    it('remove', async () => {
        const { queryClient, wrapper } = setup();
        const { result } = renderHook(() => useRemoveFromPlaylist(), { wrapper });
        await act(() =>
            result.current.mutateAsync({
                apiClientProps: { serverId: 'server-1' },
                query: { id: 'playlist-1', songId: ['song-a'] },
            }),
        );
        expect(queryClient.getQueryState(idsKey)?.isInvalidated).toBe(true);
        expectCacheDroppedFirst();
    });

    it('replace tracks', async () => {
        const { queryClient, wrapper } = setup();
        const { result } = renderHook(() => useUpdatePlaylistTracks({}), { wrapper });
        await act(() =>
            result.current.mutateAsync({
                apiClientProps: { serverId: 'server-1' },
                body: { id: 'playlist-1', songs: [] },
            } as never),
        );
        expect(queryClient.getQueryState(idsKey)?.isInvalidated).toBe(true);
        expectCacheDroppedFirst();
    });

    it('update (rename / smart rules)', async () => {
        const { wrapper } = setup();
        const { result } = renderHook(() => useUpdatePlaylist({}), { wrapper });
        await act(() =>
            result.current.mutateAsync({
                apiClientProps: { serverId: 'server-1' },
                body: { name: 'Renamed' },
                query: { id: 'playlist-1' },
            } as never),
        );
        expectCacheDroppedFirst();
    });
});
