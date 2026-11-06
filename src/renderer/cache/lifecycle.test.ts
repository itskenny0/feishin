// useCacheLifecycle Job 2 (open/close the per-server DB):
//  - leaving Jellyfin (a Navidrome/Subsonic server, or no server) must clear
//    the active DB, or the grid resolvers keep serving the old server's rows;
//  - a cosmetic currentServer replacement (updateServer({ isAdmin }) on every
//    authenticated launch) must not tear down and re-run the activation.

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    active: undefined as undefined | { serverId: string },
    dropSnapshotsForServer: vi.fn(),
    setActiveCacheDb: vi.fn(),
}));

vi.mock('/@/renderer/store', async () => {
    const { create } = await import('zustand');
    return {
        useAuthStore: create(() => ({ currentServer: null as null | Record<string, unknown> })),
        useSettingsStore: create(() => ({
            actions: { clearFirstSyncComplete: vi.fn() },
            localCache: { enabled: true, resyncOnStartup: false },
        })),
    };
});
vi.mock('./db', () => ({
    awaitActiveCacheDb: vi.fn(async () => undefined),
    closeCacheDb: vi.fn(async () => undefined),
    deleteCacheDb: vi.fn(async () => undefined),
    getActiveCacheDb: () => mocks.active,
    getLastOpenError: () => undefined,
    resetCacheDb: vi.fn(async () => undefined),
    setActiveCacheDb: mocks.setActiveCacheDb.mockImplementation(
        async (serverId?: string, userId?: string) => {
            mocks.active = serverId && userId ? { serverId } : undefined;
            return mocks.active;
        },
    ),
}));
// An integrity "reset" verdict ends the activation right after the open, so
// the test does not need a real Dexie handle.
vi.mock('./integrity', () => ({ runIntegrityCheck: vi.fn(async () => ({ action: 'reset' })) }));
vi.mock('./backends/active-backend', () => ({
    reconcileVolumeHealth: vi.fn(async () => undefined),
}));
vi.mock('./capability', () => ({ isCacheAvailable: vi.fn(async () => true) }));
vi.mock('./eviction', () => ({ estimateBytes: vi.fn(async () => 0), evict: vi.fn() }));
vi.mock('./images', () => ({ resolveThumbnail: vi.fn() }));
vi.mock('./mutations', () => ({ startWorker: vi.fn() }));
vi.mock('./offline-media', () => ({
    refreshOfflineAvailability: vi.fn(),
    refreshOfflineStats: vi.fn(),
}));
vi.mock('./offline/manager', () => ({ offlineManager: { setOnChanged: vi.fn() } }));
vi.mock('./search', () => ({ resetSearchIndexes: vi.fn() }));
vi.mock('./snapshot', () => ({
    clearAllSnapshots: vi.fn(),
    dropSnapshotsForServer: mocks.dropSnapshotsForServer,
}));
vi.mock('./sync', () => ({ cancelHydration: vi.fn(), hydrate: vi.fn() }));
vi.mock('/@/renderer/lib/network-status', () => ({ registerReachabilityProbe: vi.fn() }));
vi.mock('/@/shared/components/image/use-native-image', () => ({
    registerThumbnailResolver: vi.fn(),
}));
vi.mock('/@/shared/components/toast/toast', () => ({ toast: { error: vi.fn() } }));

import { useCacheLifecycle } from './lifecycle';

import { useAuthStore } from '/@/renderer/store';

const jellyfin = { id: 'jf', type: 'jellyfin', url: 'https://jf.example', userId: 'u1' };

const setServer = async (server: null | Record<string, unknown>): Promise<void> => {
    await act(async () => {
        useAuthStore.setState({ currentServer: server } as never);
    });
};

afterEach(async () => {
    cleanup();
    await setServer(null);
    vi.clearAllMocks();
    mocks.active = undefined;
});

describe('useCacheLifecycle server switching', () => {
    it('clears the active DB when switching to a non-Jellyfin server', async () => {
        await setServer(jellyfin);
        renderHook(() => useCacheLifecycle());
        await vi.waitFor(() => expect(mocks.active).toEqual({ serverId: 'jf' }));

        await setServer({ id: 'nd', type: 'navidrome', url: 'https://nd.example', userId: 'u2' });
        await vi.waitFor(() => expect(mocks.active).toBeUndefined());
    });

    it('does not re-run the activation when only cosmetic server fields change', async () => {
        await setServer(jellyfin);
        renderHook(() => useCacheLifecycle());
        await vi.waitFor(() => expect(mocks.setActiveCacheDb).toHaveBeenCalledTimes(1));

        // updateServer() always stores a fresh object, even for { isAdmin }.
        await setServer({ ...jellyfin, isAdmin: true });

        expect(mocks.setActiveCacheDb).toHaveBeenCalledTimes(1);
        expect(mocks.dropSnapshotsForServer).not.toHaveBeenCalled();
    });
});
