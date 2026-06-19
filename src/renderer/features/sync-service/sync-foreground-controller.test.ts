import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncActionEvent, SyncUpdateArgs } from './sync-foreground-bridge';

// --- Mock the native bridge so the controller is platform-agnostic in tests.
const { actionListeners, addListenerMock, startMock, stopMock, updateMock } = vi.hoisted(() => {
    const actionListeners: Array<(e: SyncActionEvent) => void> = [];
    return {
        actionListeners,
        addListenerMock: vi.fn((cb: (e: SyncActionEvent) => void) => {
            actionListeners.push(cb);
            return Promise.resolve(() => {
                const i = actionListeners.indexOf(cb);
                if (i >= 0) actionListeners.splice(i, 1);
            });
        }),
        startMock: vi.fn((_kind: string) => Promise.resolve()),
        stopMock: vi.fn((_kind: string) => Promise.resolve()),
        updateMock: vi.fn((_args: SyncUpdateArgs) => Promise.resolve()),
    };
});

vi.mock('./sync-foreground-bridge', () => ({
    addSyncActionListener: addListenerMock,
    isAndroidNative: () => true,
    startSyncService: startMock,
    stopSyncService: stopMock,
    updateSyncService: updateMock,
}));

// --- Mock the two cancel entry points the action handler routes to.
const { cancelOfflineSyncMock } = vi.hoisted(() => ({ cancelOfflineSyncMock: vi.fn() }));
const { cancelHydrationMock } = vi.hoisted(() => ({ cancelHydrationMock: vi.fn() }));

vi.mock('/@/renderer/cache/offline-media', () => ({
    cancelOfflineSync: cancelOfflineSyncMock,
}));
vi.mock('/@/renderer/cache/sync', () => ({
    cancelHydration: cancelHydrationMock,
}));

import { startSyncForegroundController } from './sync-foreground-controller';

import { useCacheStore } from '/@/renderer/cache/store';

const actions = () => useCacheStore.getState().actions;

const sweepProgress = (over: Partial<Record<string, unknown>> = {}) => ({
    bytesDownloaded: 1234,
    bytesPerSec: 0,
    done: 10,
    estimatedTotalBytes: undefined,
    itemsPerSec: 0,
    startedAt: 0,
    total: 100,
    ...over,
});

const offlineProgress = (over: Partial<Record<string, unknown>> = {}) => ({
    bytesDownloaded: 5678,
    bytesPerSec: 0,
    done: 2,
    entityKey: 'srv:album:a1',
    estimatedTotalBytes: undefined,
    itemsPerSec: 0,
    name: 'My Album',
    startedAt: 0,
    total: 12,
    ...over,
});

describe('sync-foreground-controller', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        actionListeners.length = 0;
        // Reset the relevant store slices.
        actions().setSweep(undefined);
        actions().setOfflineSync(undefined);
        vi.useRealTimers();
    });

    it('starts + updates the images service when a sweep becomes active', () => {
        const c = startSyncForegroundController();
        actions().setSweep({ entity: 'albums', progress: sweepProgress() as never });
        expect(startMock).toHaveBeenCalledWith('images');
        expect(updateMock).toHaveBeenCalledTimes(1);
        const arg = updateMock.mock.calls[0][0];
        expect(arg.kind).toBe('images');
        expect(arg.max).toBe(100);
        expect(arg.progress).toBe(10);
        expect(arg.indeterminate).toBe(false);
        expect(startMock).not.toHaveBeenCalledWith('downloads');
        c.stop();
    });

    it('starts + updates the downloads service independently of images', () => {
        const c = startSyncForegroundController();
        actions().setOfflineSync(offlineProgress() as never);
        expect(startMock).toHaveBeenCalledWith('downloads');
        expect(startMock).not.toHaveBeenCalledWith('images');
        const arg = updateMock.mock.calls[0][0];
        expect(arg.kind).toBe('downloads');
        expect(arg.title).toContain('My Album');
        expect(arg.max).toBe(12);
        c.stop();
    });

    it('throttles progress updates to ~1 Hz', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        const c = startSyncForegroundController();
        actions().setSweep({ entity: 'albums', progress: sweepProgress({ done: 1 }) as never });
        expect(updateMock).toHaveBeenCalledTimes(1); // initial

        // Rapid updates within the throttle window are dropped.
        vi.setSystemTime(200);
        actions().setSweep({ entity: 'albums', progress: sweepProgress({ done: 2 }) as never });
        vi.setSystemTime(500);
        actions().setSweep({ entity: 'albums', progress: sweepProgress({ done: 3 }) as never });
        expect(updateMock).toHaveBeenCalledTimes(1);

        // After the window elapses, the next update goes through.
        vi.setSystemTime(1100);
        actions().setSweep({ entity: 'albums', progress: sweepProgress({ done: 4 }) as never });
        expect(updateMock).toHaveBeenCalledTimes(2);
        c.stop();
        vi.useRealTimers();
    });

    it('stops a kind when its pipeline goes idle', () => {
        const c = startSyncForegroundController();
        actions().setSweep({ entity: 'albums', progress: sweepProgress() as never });
        expect(startMock).toHaveBeenCalledWith('images');
        actions().setSweep(undefined);
        expect(stopMock).toHaveBeenCalledWith('images');
        c.stop();
    });

    it('reports indeterminate progress when total is unknown', () => {
        const c = startSyncForegroundController();
        actions().setSweep({
            entity: 'songs',
            progress: sweepProgress({ total: undefined }) as never,
        });
        const arg = updateMock.mock.calls[0][0];
        expect(arg.indeterminate).toBe(true);
        expect(arg.max).toBe(0);
        c.stop();
    });

    it('surfaces the offline pause state in the images notification text', () => {
        const c = startSyncForegroundController();
        actions().setSweep({
            entity: 'albums',
            progress: sweepProgress({ paused: 'offline' }) as never,
        });
        const arg = updateMock.mock.calls[0][0];
        expect(arg.text).toContain('Paused');
        c.stop();
    });

    it('routes a downloads stop action to cancelOfflineSync', async () => {
        const c = startSyncForegroundController();
        await Promise.resolve(); // let addSyncActionListener resolve
        expect(actionListeners).toHaveLength(1);
        actionListeners[0]({ action: 'stop', kind: 'downloads' });
        expect(cancelOfflineSyncMock).toHaveBeenCalledTimes(1);
        expect(cancelHydrationMock).not.toHaveBeenCalled();
        expect(c.isDownloadsPaused()).toBe(false);
        c.stop();
    });

    it('routes a downloads pause action to cancelOfflineSync + sets the paused flag', async () => {
        const c = startSyncForegroundController();
        await Promise.resolve();
        actionListeners[0]({ action: 'pause', kind: 'downloads' });
        expect(cancelOfflineSyncMock).toHaveBeenCalledTimes(1);
        expect(c.isDownloadsPaused()).toBe(true);
        c.stop();
    });

    it('routes an images stop/pause action to cancelHydration', async () => {
        const c = startSyncForegroundController();
        await Promise.resolve();
        actionListeners[0]({ action: 'pause', kind: 'images' });
        expect(cancelHydrationMock).toHaveBeenCalledTimes(1);
        expect(cancelOfflineSyncMock).not.toHaveBeenCalled();
        expect(c.isImagesPaused()).toBe(true);
        c.stop();
    });

    it('stops all active kinds + unsubscribes on stop()', async () => {
        const c = startSyncForegroundController();
        await Promise.resolve();
        actions().setSweep({ entity: 'albums', progress: sweepProgress() as never });
        actions().setOfflineSync(offlineProgress() as never);
        stopMock.mockClear();
        c.stop();
        expect(stopMock).toHaveBeenCalledWith('images');
        expect(stopMock).toHaveBeenCalledWith('downloads');

        // After stop, further store changes are ignored.
        startMock.mockClear();
        actions().setSweep(undefined);
        actions().setSweep({ entity: 'songs', progress: sweepProgress() as never });
        expect(startMock).not.toHaveBeenCalled();
        // The action listener was removed.
        expect(actionListeners).toHaveLength(0);
    });

    it('reconciles a sync already running at controller start', () => {
        actions().setOfflineSync(offlineProgress() as never);
        const c = startSyncForegroundController();
        expect(startMock).toHaveBeenCalledWith('downloads');
        c.stop();
    });
});
