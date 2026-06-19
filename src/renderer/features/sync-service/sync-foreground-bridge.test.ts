import { beforeEach, describe, expect, it, vi } from 'vitest';

// The native plugin methods. registerPlugin returns this object in the mock.
const { addListenerMock, platform, startMock, stopMock, updateMock } = vi.hoisted(() => ({
    addListenerMock: vi.fn(() => Promise.resolve({ remove: vi.fn(() => Promise.resolve()) })),
    platform: { name: 'android', native: true },
    startMock: vi.fn(() => Promise.resolve()),
    stopMock: vi.fn(() => Promise.resolve()),
    updateMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => platform.name,
        isNativePlatform: () => platform.native,
    },
    registerPlugin: () => ({
        addListener: addListenerMock,
        start: startMock,
        stop: stopMock,
        update: updateMock,
    }),
}));

import {
    addSyncActionListener,
    isAndroidNative,
    startSyncService,
    stopSyncService,
    updateSyncService,
} from './sync-foreground-bridge';

describe('sync-foreground-bridge', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        platform.native = true;
        platform.name = 'android';
    });

    it('reports android-native', () => {
        expect(isAndroidNative()).toBe(true);
    });

    it('forwards start/update/stop to the native plugin on Android', async () => {
        await startSyncService('images');
        await updateSyncService({ kind: 'images', max: 10, progress: 1, title: 'x' });
        await stopSyncService('images');
        expect(startMock).toHaveBeenCalledWith({ kind: 'images' });
        expect(updateMock).toHaveBeenCalledWith({
            kind: 'images',
            max: 10,
            progress: 1,
            title: 'x',
        });
        expect(stopMock).toHaveBeenCalledWith({ kind: 'images' });
    });

    it('registers a syncAction listener and returns a remover', async () => {
        const cb = vi.fn();
        const remover = await addSyncActionListener(cb);
        expect(addListenerMock).toHaveBeenCalledWith('syncAction', cb);
        expect(typeof remover).toBe('function');
    });

    it('no-ops on non-android platforms (web)', async () => {
        platform.native = false;
        platform.name = 'web';
        await startSyncService('downloads');
        await updateSyncService({ kind: 'downloads' });
        await stopSyncService('downloads');
        const remover = await addSyncActionListener(vi.fn());
        expect(startMock).not.toHaveBeenCalled();
        expect(updateMock).not.toHaveBeenCalled();
        expect(stopMock).not.toHaveBeenCalled();
        expect(addListenerMock).not.toHaveBeenCalled();
        expect(remover).toBeUndefined();
    });

    it('no-ops on ios native', async () => {
        platform.native = true;
        platform.name = 'ios';
        await startSyncService('images');
        expect(startMock).not.toHaveBeenCalled();
        expect(isAndroidNative()).toBe(false);
    });
});
