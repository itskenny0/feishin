// Unit tests for the offline-download entry-point hook + the LibraryItem ->
// OfflineEntityType mapping. We mock the offline-media pipeline, the settings /
// cache stores (for the availability gate), the current-server hook, and the
// toast, then drive useOfflineDownload via renderHook and assert:
//   - LibraryItem mapping covers every downloadable entity + rejects the rest
//   - availability gates on localCache.enabled AND cacheAvailable !== false
//   - download() marshals the entities into a single enqueueOfflineMany call
//     with the current server id, and emits exactly one toast per invocation.

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        cacheState: { cacheAvailable: true as boolean | undefined },
        enqueueOfflineMany: vi.fn().mockResolvedValue(undefined),
        server: { id: 'server-1' } as null | { id: string },
        settingsState: { localCache: { enabled: true as boolean | undefined } },
        toast: { error: vi.fn(), info: vi.fn() },
    };
});

// Mock the heavy controller import chain so pulling the hook in doesn't drag
// in the player store / i18n bootstrap.
vi.mock('/@/renderer/api', () => ({ api: { controller: {} } }));
vi.mock('/@/renderer/cache/offline', () => ({
    enqueueOfflineMany: mocks.enqueueOfflineMany,
}));
vi.mock('/@/renderer/cache/store', () => ({
    useCacheStore: (selector: (s: typeof mocks.cacheState) => unknown) =>
        selector(mocks.cacheState),
}));
vi.mock('/@/renderer/store', () => ({
    useCurrentServer: () => mocks.server,
}));
vi.mock('/@/renderer/store/settings.store', () => {
    const useSettingsStore = (selector: (s: typeof mocks.settingsState) => unknown) =>
        selector(mocks.settingsState);
    useSettingsStore.getState = () => mocks.settingsState;
    return { useSettingsStore };
});
vi.mock('/@/shared/components/toast/toast', () => ({ toast: mocks.toast }));
vi.mock('react-i18next', () => ({
    initReactI18next: { init: vi.fn(), type: '3rdParty' },
    useTranslation: () => ({
        t: (_key: string, opts?: { defaultValue?: string; name?: string }) =>
            opts?.defaultValue ?? _key,
    }),
}));

import {
    libraryItemToOfflineEntityType,
    useOfflineDownload,
} from '/@/renderer/features/context-menu/hooks/use-offline-download';
import { LibraryItem } from '/@/shared/types/domain-types';

describe('libraryItemToOfflineEntityType', () => {
    it('maps each downloadable LibraryItem to its offline entity type', () => {
        expect(libraryItemToOfflineEntityType(LibraryItem.ALBUM)).toBe('album');
        expect(libraryItemToOfflineEntityType(LibraryItem.ARTIST)).toBe('artist');
        expect(libraryItemToOfflineEntityType(LibraryItem.ALBUM_ARTIST)).toBe('artist');
        expect(libraryItemToOfflineEntityType(LibraryItem.GENRE)).toBe('genre');
        expect(libraryItemToOfflineEntityType(LibraryItem.PLAYLIST)).toBe('playlist');
        expect(libraryItemToOfflineEntityType(LibraryItem.SONG)).toBe('song');
        expect(libraryItemToOfflineEntityType(LibraryItem.PLAYLIST_SONG)).toBe('song');
    });

    it('returns undefined for entities the offline engine cannot enumerate', () => {
        expect(libraryItemToOfflineEntityType(LibraryItem.FOLDER)).toBeUndefined();
        expect(libraryItemToOfflineEntityType(LibraryItem.QUEUE_SONG)).toBeUndefined();
    });
});

describe('useOfflineDownload', () => {
    beforeEach(() => {
        mocks.settingsState.localCache.enabled = true;
        mocks.cacheState.cacheAvailable = true;
        mocks.server = { id: 'server-1' };
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('is available when cache is enabled and IndexedDB is present', () => {
        const { result } = renderHook(() => useOfflineDownload());
        expect(result.current.available).toBe(true);
    });

    it('is unavailable when the local cache is disabled', () => {
        mocks.settingsState.localCache.enabled = false;
        const { result } = renderHook(() => useOfflineDownload());
        expect(result.current.available).toBe(false);
    });

    it('is unavailable when IndexedDB is explicitly absent', () => {
        mocks.cacheState.cacheAvailable = false;
        const { result } = renderHook(() => useOfflineDownload());
        expect(result.current.available).toBe(false);
    });

    it('stays available while capability is still being probed (undefined)', () => {
        mocks.cacheState.cacheAvailable = undefined;
        const { result } = renderHook(() => useOfflineDownload());
        expect(result.current.available).toBe(true);
    });

    it('enqueues all entities in one enqueueOfflineMany call with the server id', async () => {
        const { result } = renderHook(() => useOfflineDownload());
        await result.current.download([
            { entityType: 'album', id: 'a1', name: 'Album One' },
            { entityType: 'album', id: 'a2', name: 'Album Two' },
        ]);

        expect(mocks.enqueueOfflineMany).toHaveBeenCalledTimes(1);
        expect(mocks.enqueueOfflineMany).toHaveBeenCalledWith([
            { entityId: 'a1', entityType: 'album', name: 'Album One', serverId: 'server-1' },
            { entityId: 'a2', entityType: 'album', name: 'Album Two', serverId: 'server-1' },
        ]);
        // Exactly one "downloading…" toast per invocation, not per entity.
        expect(mocks.toast.info).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when there is no current server', async () => {
        mocks.server = null;
        const { result } = renderHook(() => useOfflineDownload());
        await result.current.download([{ entityType: 'album', id: 'a1', name: 'A' }]);
        expect(mocks.enqueueOfflineMany).not.toHaveBeenCalled();
    });

    it('is a no-op for an empty entity list', async () => {
        const { result } = renderHook(() => useOfflineDownload());
        await result.current.download([]);
        expect(mocks.enqueueOfflineMany).not.toHaveBeenCalled();
        expect(mocks.toast.info).not.toHaveBeenCalled();
    });

    it('surfaces an error toast when the enqueue fails', async () => {
        mocks.enqueueOfflineMany.mockRejectedValueOnce(new Error('boom'));
        const { result } = renderHook(() => useOfflineDownload());
        await result.current.download([{ entityType: 'album', id: 'a1', name: 'A' }]);
        expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    });
});
