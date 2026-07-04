import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/core', () => ({
    Capacitor: { convertFileSrc: (p: string) => `cap://${p}` },
}));

const { dl, files } = vi.hoisted(() => ({
    dl: {
        // Recorded downloadFile calls, and knobs for the cancellation test.
        calls: [] as Array<{ downloadId: string; path: string; url: string }>,
        cancelled: [] as string[],
        // When set, downloadFile blocks until released (or a cancel releases it).
        hang: false,
        nextBytes: 4242,
        release: null as (() => void) | null,
    },
    files: new Map<string, string>(),
}));

vi.mock('./volumes', () => ({
    MediaVolumes: {
        cancelDownload: async ({ downloadId }: { downloadId: string }) => {
            dl.cancelled.push(downloadId);
            if (dl.release) dl.release();
        },
        deleteFile: async ({ path }: { path: string }) => {
            files.delete(path);
        },
        downloadFile: async ({
            downloadId,
            path,
            url,
        }: {
            downloadId: string;
            path: string;
            url: string;
        }) => {
            dl.calls.push({ downloadId, path, url });
            if (dl.hang) {
                await new Promise<void>((resolve) => {
                    dl.release = resolve;
                });
            }
            files.set(path, url);
            return { bytes: dl.nextBytes };
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

    describe('storeFromUrl (native streaming)', () => {
        beforeEach(() => {
            dl.calls = [];
            dl.cancelled = [];
            dl.hang = false;
            dl.nextBytes = 4242;
            dl.release = null;
        });

        it('streams a URL to a file and returns the ref + written bytes', async () => {
            const be = new CapacitorFsBackend(() => VOL);
            const { ref, size } = await be.storeFromUrl('audio', 's:1', 'https://srv/dl/1');
            expect(size).toBe(4242);
            expect(ref).toMatchObject({ kind: 'fs', volumeId: 'V1' });
            if (ref.kind !== 'fs') throw new Error('expected fs');
            expect(ref.path).toBe('/sd/Android/data/app/files/feishin-cache/audio/s_1');
            // Native was handed the file path, the source URL, and a stable id.
            expect(dl.calls).toEqual([
                { downloadId: 'audio:s:1', path: ref.path, url: 'https://srv/dl/1' },
            ]);
        });

        it('rejects (without downloading) when no volume is resolved', async () => {
            const be = new CapacitorFsBackend(() => undefined);
            await expect(be.storeFromUrl('audio', 'k', 'https://srv/dl/1')).rejects.toThrow(
                /no active fs volume/,
            );
            expect(dl.calls).toHaveLength(0);
        });

        it('throws immediately for an already-aborted signal, no download', async () => {
            const be = new CapacitorFsBackend(() => VOL);
            const ac = new AbortController();
            ac.abort();
            await expect(
                be.storeFromUrl('audio', 'k', 'https://srv/dl/1', { signal: ac.signal }),
            ).rejects.toThrow();
            expect(dl.calls).toHaveLength(0);
        });

        it('cancels the native download when the signal aborts mid-flight', async () => {
            dl.hang = true;
            const be = new CapacitorFsBackend(() => VOL);
            const ac = new AbortController();
            const p = be.storeFromUrl('audio', 's:9', 'https://srv/dl/9', { signal: ac.signal });
            // Let downloadFile register + start hanging, then abort.
            await Promise.resolve();
            ac.abort();
            await p;
            expect(dl.cancelled).toContain('audio:s:9');
        });
    });
});
