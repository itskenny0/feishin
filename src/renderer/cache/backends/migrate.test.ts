import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryCacheDb } from '../db';

const { fsFiles } = vi.hoisted(() => ({ fsFiles: new Map<string, Blob>() }));

// Fake backends keyed by ref kind. The migrate engine dispatches the SOURCE
// backend through backendForRef (mocked here); the DESTINATION backend is
// passed in as `to`.
const fakeFs = {
    health: async () => ({ available: true }),
    id: 'capacitor-fs' as const,
    load: async (ref: any) => (ref.kind === 'fs' ? fsFiles.get(ref.path) : undefined),
    remove: async (ref: any) => {
        if (ref.kind === 'fs') fsFiles.delete(ref.path);
    },
    resolveUrl: (ref: any) => (ref.kind === 'fs' ? `cap://${ref.path}` : undefined),
    store: async (ns: string, key: string, blob: Blob) => {
        const path = `/sd/${ns}/${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        fsFiles.set(path, blob);
        return { kind: 'fs', path, volumeId: 'V1' };
    },
};
const fakeIdb = {
    health: async () => ({ available: true }),
    id: 'idb' as const,
    load: async (ref: any) => (ref.kind === 'idb' ? ref.blob : undefined),
    remove: async () => {},
    store: async (_ns: string, _key: string, blob: Blob) => ({ blob, kind: 'idb' }),
};

vi.mock('./active-backend', () => ({
    backendForRef: (ref: any) => (ref.kind === 'fs' ? fakeFs : fakeIdb),
}));

import { migrateBlobs, startFresh } from './migrate';

class TableShim<T extends Record<string, any>> {
    readonly rows = new Map<unknown, T>();
    private readonly pk: string;
    constructor(pk: string, seed: T[] = []) {
        this.pk = pk;
        for (const r of seed) this.rows.set(r[pk], r);
    }
    async clear(): Promise<void> {
        this.rows.clear();
    }
    async delete(key: unknown): Promise<void> {
        this.rows.delete(key);
    }
    async put(row: T): Promise<void> {
        this.rows.set(row[this.pk], row);
    }
    async toArray(): Promise<T[]> {
        return [...this.rows.values()];
    }
}

const mediaRow = (id: string, extra: Record<string, any>) => ({
    ByteSize: 100,
    Container: 'mp3',
    DownloadedAt: 0,
    EntityKeys: ['srv:album:a1'],
    Key: `srv:${id}`,
    MimeType: 'audio/mpeg',
    ServerId: 'srv',
    SongId: id,
    ...extra,
});

const thumbRow = (id: string, extra: Record<string, any>) => ({
    __cachedAt: 0,
    ByteSize: 10,
    Etag: undefined,
    ItemId: id,
    LastUsed: 0,
    MissAt: undefined,
    Variant: 'table',
    ...extra,
});

const makeDb = (media: any[], thumbs: any[], targets: any[] = []) =>
    ({
        mediaBlobs: new TableShim('Key', media),
        offlineTargets: new TableShim('Key', targets),
        thumbnails: new TableShim('ItemId', thumbs),
    }) as unknown as LibraryCacheDb;

describe('migrateBlobs', () => {
    beforeEach(() => fsFiles.clear());

    it('moves idb rows to the fs target, rewriting refs and removing the source', async () => {
        const db = makeDb(
            [mediaRow('s1', { Backend: 'idb', Blob: new Blob(['audio']) })],
            [thumbRow('i1', { Backend: 'idb', Blob: new Blob(['img']) })],
        );

        const res = await migrateBlobs({ db, to: fakeFs as any, toVolumeId: 'V1' });

        expect(res).toEqual({ failed: 0, migrated: 2 });
        const m = [...(db.mediaBlobs as any).rows.values()][0];
        expect(m.Backend).toBe('capacitor-fs');
        expect(m.Path).toBe('/sd/audio/srv_s1');
        expect(m.Blob).toBeUndefined();
        expect(m.ByteSize).toBe(100);
        // bytes actually landed on the fake fs
        expect(await fsFiles.get('/sd/audio/srv_s1')!.text()).toBe('audio');
    });

    it('is resumable: a row already on the target backend is skipped', async () => {
        fsFiles.set('/sd/audio/srv_s1', new Blob(['already']));
        const db = makeDb(
            [mediaRow('s1', { Backend: 'capacitor-fs', Path: '/sd/audio/srv_s1', VolumeId: 'V1' })],
            [],
        );
        const storeSpy = vi.spyOn(fakeFs, 'store');

        const res = await migrateBlobs({ db, to: fakeFs as any, toVolumeId: 'V1' });

        expect(res.migrated).toBe(0);
        expect(storeSpy).not.toHaveBeenCalled();
        storeSpy.mockRestore();
    });

    it('reports progress and honors an abort signal', async () => {
        const db = makeDb(
            [
                mediaRow('s1', { Backend: 'idb', Blob: new Blob(['a']) }),
                mediaRow('s2', { Backend: 'idb', Blob: new Blob(['b']) }),
            ],
            [],
        );
        const controller = new AbortController();
        const seen: number[] = [];

        const res = await migrateBlobs({
            db,
            onProgress: (p) => {
                seen.push(p.items);
                controller.abort(); // abort after the first item
            },
            signal: controller.signal,
            to: fakeFs as any,
            toVolumeId: 'V1',
        });

        expect(seen[0]).toBe(1);
        expect(res.migrated).toBe(1); // second row skipped by the abort
    });

    it('skips negative-cache thumbnail markers (no bytes)', async () => {
        const db = makeDb([], [thumbRow('i1', { Blob: undefined, MissAt: 123 })]);
        const res = await migrateBlobs({ db, to: fakeFs as any, toVolumeId: 'V1' });
        expect(res).toEqual({ failed: 0, migrated: 0 });
    });
});

describe('startFresh', () => {
    beforeEach(() => fsFiles.clear());

    it('clears all bytes and marks every offline target pending', async () => {
        fsFiles.set('/sd/audio/srv_s1', new Blob(['x']));
        const db = makeDb(
            [mediaRow('s1', { Backend: 'capacitor-fs', Path: '/sd/audio/srv_s1', VolumeId: 'V1' })],
            [thumbRow('i1', { Backend: 'idb', Blob: new Blob(['y']) })],
            [{ AddedAt: 0, Key: 'srv:album:a1', Status: 'ready' }],
        );

        await startFresh({ db });

        expect((db.mediaBlobs as any).rows.size).toBe(0);
        expect((db.thumbnails as any).rows.size).toBe(0);
        expect(fsFiles.has('/sd/audio/srv_s1')).toBe(false);
        const target = [...(db.offlineTargets as any).rows.values()][0];
        expect(target.Status).toBe('pending');
    });
});
