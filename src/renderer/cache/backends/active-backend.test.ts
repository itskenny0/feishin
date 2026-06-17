import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state } = vi.hoisted(() => ({ state: { android: true, volumes: [] as any[] } }));

vi.mock('./volumes', () => ({
    isAndroidNative: () => state.android,
    listVolumes: async () => state.volumes,
}));

import {
    getActiveBackend,
    getActiveVolume,
    refreshVolumes,
    setActiveVolume,
} from './active-backend';

const SD = {
    freeBytes: 1,
    id: 'V1',
    label: 'SD card',
    path: '/sd/files',
    removable: true,
    totalBytes: 1,
};
const INT = {
    freeBytes: 1,
    id: 'internal',
    label: 'Internal storage',
    path: '/int/files',
    removable: false,
    totalBytes: 1,
};

describe('active backend', () => {
    beforeEach(async () => {
        state.android = true;
        state.volumes = [INT, SD];
        await refreshVolumes();
        await setActiveVolume(null);
    });

    it('defaults to the idb backend when no volume is chosen', () => {
        expect(getActiveBackend().id).toBe('idb');
    });

    it('uses the fs backend once an SD volume is chosen', async () => {
        await setActiveVolume('V1');
        expect(getActiveVolume()?.id).toBe('V1');
        expect(getActiveBackend().id).toBe('capacitor-fs');
    });

    it('falls back to idb on non-android platforms', async () => {
        state.android = false;
        await setActiveVolume('V1');
        expect(getActiveBackend().id).toBe('idb');
    });

    it('keeps the fs backend but resolves no volume when the card is removed', async () => {
        await setActiveVolume('V1');
        state.volumes = [INT];
        await refreshVolumes();
        expect(getActiveVolume()).toBeUndefined();
        // Selection still returns fs so reads attempt + fail gracefully; health()
        // reports unavailable, which drives the Task 10 banner.
        expect(getActiveBackend().id).toBe('capacitor-fs');
        expect(await getActiveBackend().health()).toEqual({ available: false });
    });
});
