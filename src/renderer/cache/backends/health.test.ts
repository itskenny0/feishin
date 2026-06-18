import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { android: true, volumes: [] as any[] } }));

vi.mock('./volumes', () => ({
    isAndroidNative: () => state.android,
    listVolumes: async () => state.volumes,
}));

import { useCacheStore } from '../store';
import { reconcileVolumeHealth, setActiveVolume } from './active-backend';

const SD = {
    freeBytes: 1,
    id: 'V1',
    label: 'SD card',
    path: '/sd/files',
    removable: true,
    totalBytes: 1,
};

describe('reconcileVolumeHealth', () => {
    beforeEach(async () => {
        state.android = true;
        state.volumes = [SD];
        useCacheStore.getState().actions.setVolumeAvailable(true);
        await setActiveVolume(null);
    });

    it('reports available on the idb backend (no volume chosen)', async () => {
        expect(await reconcileVolumeHealth()).toBe(true);
        expect(useCacheStore.getState().volumeAvailable).toBe(true);
    });

    it('reports available when the chosen SD volume is present', async () => {
        await setActiveVolume('V1');
        expect(await reconcileVolumeHealth()).toBe(true);
        expect(useCacheStore.getState().volumeAvailable).toBe(true);
    });

    it('reports unavailable when the chosen SD volume is gone', async () => {
        await setActiveVolume('V1');
        state.volumes = []; // card removed
        expect(await reconcileVolumeHealth()).toBe(false);
        expect(useCacheStore.getState().volumeAvailable).toBe(false);
    });
});
