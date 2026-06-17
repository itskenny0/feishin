// LocalMediaStore × filesystem backend. Proves save() routes bytes through the
// active backend (storing a Path, not an inline Blob), loadBlob/resolveUrl
// dispatch on the row, and delete reclaims the file via the backend. The idb
// path is covered by media-store.test.ts; here we mock the active backend to a
// fake fs backend so no Capacitor bridge is needed.

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedMediaBlob, OfflineTargetRow } from '/@/renderer/cache/types';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { files, removed } = vi.hoisted(() => ({
    files: new Map<string, Blob>(),
    removed: [] as string[],
}));

const fakeFsBackend = {
    health: async () => ({ available: true }),
    id: 'capacitor-fs' as const,
    load: async (ref: any) => (ref.kind === 'fs' ? files.get(ref.path) : undefined),
    remove: async (ref: any) => {
        if (ref.kind === 'fs') {
            removed.push(ref.path);
            files.delete(ref.path);
        }
    },
    resolveUrl: (ref: any) => (ref.kind === 'fs' ? `cap://${ref.path}` : undefined),
    store: async (_ns: string, key: string, blob: Blob) => {
        const path = `/sd/feishin-cache/audio/${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        files.set(path, blob);
        return { kind: 'fs', path, volumeId: 'V1' };
    },
};

vi.mock('/@/renderer/cache/backends/active-backend', () => ({
    backendForRef: () => fakeFsBackend,
    getActiveBackend: () => fakeFsBackend,
}));

import { LocalMediaStore } from '/@/renderer/cache/media-store';

class TableShim<T extends Record<string, any>> {
    readonly rows = new Map<unknown, T>();
    private readonly pk: string;
    constructor(pk: string) {
        this.pk = pk;
    }
    async clear(): Promise<void> {
        this.rows.clear();
    }
    async delete(key: unknown): Promise<void> {
        this.rows.delete(key);
    }
    async get(key: unknown): Promise<T | undefined> {
        return this.rows.get(key);
    }
    async put(row: T): Promise<void> {
        this.rows.set(row[this.pk], row);
    }
    where(field: string) {
        return {
            equals: (value: unknown) => ({
                toArray: async (): Promise<T[]> =>
                    [...this.rows.values()].filter((r) => {
                        const v = r[field];
                        return Array.isArray(v) ? v.includes(value) : v === value;
                    }),
            }),
        };
    }
}

const makeDb = () =>
    ({
        mediaBlobs: new TableShim<CachedMediaBlob>('Key'),
        offlineTargets: new TableShim<OfflineTargetRow>('Key'),
    }) as unknown as LibraryCacheDb;

describe('LocalMediaStore on the filesystem backend', () => {
    let db: LibraryCacheDb;
    let store: LocalMediaStore;

    beforeEach(() => {
        files.clear();
        removed.length = 0;
        db = makeDb();
        store = new LocalMediaStore(() => db);
    });

    it('save() stores a Path (no inline Blob) and preserves ByteSize', async () => {
        const fresh = await store.save({
            blob: new Blob([new Uint8Array(2048)]),
            container: 'flac',
            entityKey: 'srv:album:a1',
            serverId: 'srv',
            songId: 's1',
        });
        expect(fresh).toBe(true);
        const row = await store.get('srv', 's1');
        expect(row?.Backend).toBe('capacitor-fs');
        expect(row?.Path).toBe('/sd/feishin-cache/audio/srv_s1');
        expect(row?.Blob).toBeUndefined();
        expect(row?.ByteSize).toBe(2048);
    });

    it('loadBlob() materializes fs bytes and resolveUrl() yields a file URL', async () => {
        await store.save({
            blob: new Blob([new Uint8Array(4)]),
            container: 'mp3',
            entityKey: 'srv:album:a1',
            serverId: 'srv',
            songId: 's2',
        });
        const row = (await store.get('srv', 's2'))!;
        expect(await store.loadBlob(row)).toBeInstanceOf(Blob);
        expect(store.resolveUrl(row)).toBe('cap:///sd/feishin-cache/audio/srv_s2');
    });

    it('delete() reclaims the file via the backend', async () => {
        await store.save({
            blob: new Blob([new Uint8Array(4)]),
            container: 'mp3',
            entityKey: 'srv:album:a1',
            serverId: 'srv',
            songId: 's3',
        });
        await store.delete('srv', 's3');
        expect(removed).toContain('/sd/feishin-cache/audio/srv_s3');
        expect(await store.get('srv', 's3')).toBeUndefined();
    });
});
