import { describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
    Capacitor: { convertFileSrc: (p: string) => `cap://${p}` },
}));

const { files } = vi.hoisted(() => ({ files: new Map<string, string>() }));

vi.mock('./volumes', () => ({
    MediaVolumes: {
        deleteFile: async ({ path }: { path: string }) => {
            files.delete(path);
        },
        mkdirp: async () => {},
        readFile: async ({ path }: { path: string }) => {
            const data = files.get(path);
            if (data === undefined) throw new Error('ENOENT');
            return { dataBase64: data };
        },
        stat: async ({ path }: { path: string }) => ({ exists: files.has(path), size: 0 }),
        writeFile: async ({ dataBase64, path }: { dataBase64: string; path: string }) => {
            files.set(path, dataBase64);
        },
    },
}));

import { CapacitorFsBackend } from './capacitor-fs-backend';

const VOL = {
    freeBytes: 9,
    id: 'V1',
    label: 'SD card',
    path: '/sd/Android/data/app/files',
    removable: true,
    totalBytes: 9,
};

describe('CapacitorFsBackend', () => {
    it('stores bytes to a file and reads them back', async () => {
        const be = new CapacitorFsBackend(() => VOL);
        const ref = await be.store('audio', 's:1', new Blob(['hello']));
        expect(ref).toMatchObject({ kind: 'fs', volumeId: 'V1' });
        if (ref.kind !== 'fs') throw new Error('expected fs');
        expect(ref.path.startsWith('/sd/Android/data/app/files/feishin-cache/audio/')).toBe(true);
        const back = await be.load(ref);
        expect(await back!.text()).toBe('hello');
    });

    it('resolveUrl runs the path through convertFileSrc', () => {
        const be = new CapacitorFsBackend(() => VOL);
        expect(be.resolveUrl({ kind: 'fs', path: '/sd/x', volumeId: 'V1' })).toBe('cap:///sd/x');
    });

    it('remove deletes the file', async () => {
        const be = new CapacitorFsBackend(() => VOL);
        const ref = await be.store('image', 'k', new Blob(['x']));
        await be.remove(ref);
        expect(await be.load(ref)).toBeUndefined();
    });

    it('store rejects when no volume is resolved', async () => {
        const be = new CapacitorFsBackend(() => undefined);
        await expect(be.store('audio', 'k', new Blob(['x']))).rejects.toThrow(
            /no active fs volume/,
        );
    });

    it('health reflects whether a volume is resolved', async () => {
        expect(await new CapacitorFsBackend(() => VOL).health()).toEqual({ available: true });
        expect(await new CapacitorFsBackend(() => undefined).health()).toEqual({
            available: false,
        });
    });
});
