import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listVolumesMock } = vi.hoisted(() => ({ listVolumesMock: vi.fn() }));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        convertFileSrc: (p: string) => `http://localhost/_capacitor_file_${p}`,
        getPlatform: () => 'android',
        isNativePlatform: () => true,
    },
    registerPlugin: () => ({ listVolumes: listVolumesMock }),
}));

import { isAndroidNative, listVolumes } from './volumes';

describe('volumes wrapper', () => {
    beforeEach(() => listVolumesMock.mockReset());

    it('reports android native', () => {
        expect(isAndroidNative()).toBe(true);
    });

    it('passes through plugin volumes', async () => {
        listVolumesMock.mockResolvedValue({
            volumes: [
                {
                    freeBytes: 1,
                    id: 'internal',
                    label: 'Internal storage',
                    path: '/data',
                    removable: false,
                    totalBytes: 2,
                },
            ],
        });
        const v = await listVolumes();
        expect(v).toHaveLength(1);
        expect(v[0].id).toBe('internal');
    });

    it('swallows plugin errors and returns empty', async () => {
        // A malformed payload makes the wrapper throw inside its try (here,
        // reading `.volumes` off undefined), which is the same catch path a
        // genuine plugin rejection takes. We avoid mockRejectedValue on purpose:
        // the eager rejected promise it stores in the spy's mock.results trips
        // vitest's unhandled-rejection bookkeeping even though listVolumes does
        // catch it.
        listVolumesMock.mockResolvedValue(undefined as never);
        expect(await listVolumes()).toEqual([]);
    });
});
