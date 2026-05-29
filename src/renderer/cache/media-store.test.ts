// Unit tests for LocalMediaStore — the offline-media blob backend.
//
// We don't drive real IndexedDB here (the repo's test setup mocks
// `idb-keyval` and has no fake-indexeddb dependency). Instead we follow the
// same approach as search.test.ts: construct the store against an in-memory
// Dexie-table shim that implements only the methods LocalMediaStore touches
// (get / put / delete / where().equals().toArray() / each / count / clear /
// toArray). This proves the membership/eviction bookkeeping without coupling
// to a real DB.

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedMediaBlob, OfflineTargetRow } from '/@/renderer/cache/types';

import { beforeEach, describe, expect, it } from 'vitest';

import {
    blobKey,
    LocalMediaStore,
    mimeForContainer,
    targetKey,
} from '/@/renderer/cache/media-store';

// --- in-memory Dexie table shim ---------------------------------------

class TableShim<T extends Record<string, any>> {
    readonly rows = new Map<unknown, T>();
    private readonly pk: string;

    constructor(pk: string) {
        this.pk = pk;
    }

    async clear(): Promise<void> {
        this.rows.clear();
    }

    async count(): Promise<number> {
        return this.rows.size;
    }

    async delete(key: unknown): Promise<void> {
        this.rows.delete(key);
    }

    async each(fn: (row: T) => void): Promise<void> {
        for (const row of this.rows.values()) fn(row);
    }

    async get(key: unknown): Promise<T | undefined> {
        return this.rows.get(key);
    }

    async put(row: T): Promise<void> {
        this.rows.set(row[this.pk], row);
    }

    async toArray(): Promise<T[]> {
        return [...this.rows.values()];
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

const makeDb = () => {
    const mediaBlobs = new TableShim<CachedMediaBlob>('Key');
    const offlineTargets = new TableShim<OfflineTargetRow>('Key');
    return { mediaBlobs, offlineTargets } as unknown as LibraryCacheDb;
};

const blob = (size: number): Blob => new Blob([new Uint8Array(size)]);

describe('mimeForContainer', () => {
    it('maps known containers and falls back to audio/mpeg', () => {
        expect(mimeForContainer('flac')).toBe('audio/flac');
        expect(mimeForContainer('FLAC')).toBe('audio/flac');
        expect(mimeForContainer('opus')).toBe('audio/ogg');
        expect(mimeForContainer(undefined)).toBe('audio/mpeg');
        expect(mimeForContainer('weird')).toBe('audio/mpeg');
    });
});

describe('key helpers', () => {
    it('namespaces blob + target keys', () => {
        expect(blobKey('srv', 's1')).toBe('srv:s1');
        expect(targetKey('srv', 'album', 'al1')).toBe('srv:album:al1');
    });
});

describe('LocalMediaStore blob CRUD', () => {
    let db: LibraryCacheDb;
    let store: LocalMediaStore;

    beforeEach(() => {
        db = makeDb();
        store = new LocalMediaStore(() => db);
    });

    it('saves a new blob and reports it as new', async () => {
        const isNew = await store.save({
            blob: blob(100),
            container: 'flac',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        expect(isNew).toBe(true);
        expect(await store.has('srv', 's1')).toBe(true);
        const row = await store.get('srv', 's1');
        expect(row?.ByteSize).toBe(100);
        expect(row?.MimeType).toBe('audio/flac');
        expect(row?.EntityKeys).toEqual(['srv:album:al1']);
    });

    it('merges entity membership instead of re-downloading an existing blob', async () => {
        await store.save({
            blob: blob(100),
            container: 'flac',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        const isNew = await store.save({
            blob: blob(100),
            container: 'flac',
            entityKey: 'srv:playlist:pl1',
            serverId: 'srv',
            songId: 's1',
        });
        expect(isNew).toBe(false);
        const row = await store.get('srv', 's1');
        expect(row?.EntityKeys).toEqual(['srv:album:al1', 'srv:playlist:pl1']);
        // Still only one blob.
        expect(await store.count()).toBe(1);
    });

    it('totalBytes sums every blob', async () => {
        await store.save({
            blob: blob(100),
            container: 'mp3',
            entityKey: 'e1',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(250),
            container: 'mp3',
            entityKey: 'e1',
            serverId: 'srv',
            songId: 's2',
        });
        expect(await store.totalBytes()).toBe(350);
        expect(await store.count()).toBe(2);
    });

    it('listByEntity returns only blobs tagged for that entity', async () => {
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'A',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(20),
            container: 'mp3',
            entityKey: 'A',
            serverId: 'srv',
            songId: 's2',
        });
        await store.save({
            blob: blob(30),
            container: 'mp3',
            entityKey: 'B',
            serverId: 'srv',
            songId: 's3',
        });
        const a = await store.listByEntity('A');
        expect(a.map((r) => r.SongId).sort()).toEqual(['s1', 's2']);
    });

    it('has() returns false when no active DB', async () => {
        const orphan = new LocalMediaStore(() => undefined);
        expect(await orphan.has('srv', 's1')).toBe(false);
        expect(await orphan.totalBytes()).toBe(0);
    });
});

describe('LocalMediaStore eviction by entity', () => {
    let db: LibraryCacheDb;
    let store: LocalMediaStore;

    beforeEach(() => {
        db = makeDb();
        store = new LocalMediaStore(() => db);
    });

    it('deletes solely-owned blobs and reclaims their bytes', async () => {
        await store.save({
            blob: blob(100),
            container: 'mp3',
            entityKey: 'A',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(50),
            container: 'mp3',
            entityKey: 'A',
            serverId: 'srv',
            songId: 's2',
        });
        const reclaimed = await store.deleteEntity('A');
        expect(reclaimed).toBe(150);
        expect(await store.count()).toBe(0);
    });

    it('keeps a shared blob and only drops the membership', async () => {
        // s1 belongs to both A and B; s2 only to A.
        await store.save({
            blob: blob(100),
            container: 'mp3',
            entityKey: 'A',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(100),
            container: 'mp3',
            entityKey: 'B',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(40),
            container: 'mp3',
            entityKey: 'A',
            serverId: 'srv',
            songId: 's2',
        });

        const reclaimed = await store.deleteEntity('A');
        // Only s2 was solely owned by A → 40 bytes reclaimed.
        expect(reclaimed).toBe(40);
        // s1 survives, now only owned by B.
        const s1 = await store.get('srv', 's1');
        expect(s1?.EntityKeys).toEqual(['B']);
        expect(await store.count()).toBe(1);
    });
});

describe('LocalMediaStore targets', () => {
    let db: LibraryCacheDb;
    let store: LocalMediaStore;

    beforeEach(() => {
        db = makeDb();
        store = new LocalMediaStore(() => db);
    });

    const target = (key: string, addedAt: number): OfflineTargetRow => ({
        AddedAt: addedAt,
        Bytes: 0,
        DownloadedCount: 0,
        EntityId: 'al1',
        EntityType: 'album',
        Key: key,
        LastError: undefined,
        Name: key,
        ServerId: 'srv',
        SongCount: undefined,
        Status: 'idle',
        UpdatedAt: addedAt,
    });

    it('lists targets sorted by AddedAt', async () => {
        await store.putTarget(target('b', 200));
        await store.putTarget(target('a', 100));
        const rows = await store.listTargets();
        expect(rows.map((r) => r.Key)).toEqual(['a', 'b']);
    });

    it('patchTarget merges fields and bumps UpdatedAt', async () => {
        await store.putTarget(target('a', 100));
        await store.patchTarget('a', { Bytes: 999, Status: 'complete' });
        const row = await store.getTarget('a');
        expect(row?.Bytes).toBe(999);
        expect(row?.Status).toBe('complete');
        expect(row?.UpdatedAt).toBeGreaterThanOrEqual(100);
    });

    it('removeTarget reclaims solely-owned blobs and drops the row', async () => {
        await store.putTarget(target('srv:album:al1', 100));
        await store.save({
            blob: blob(500),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        const reclaimed = await store.removeTarget('srv:album:al1');
        expect(reclaimed).toBe(500);
        expect(await store.getTarget('srv:album:al1')).toBeUndefined();
        expect(await store.count()).toBe(0);
    });

    it('clearAll wipes blobs and targets', async () => {
        await store.putTarget(target('a', 100));
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'a',
            serverId: 'srv',
            songId: 's1',
        });
        await store.clearAll();
        expect(await store.count()).toBe(0);
        expect(await store.listTargets()).toEqual([]);
    });
});
