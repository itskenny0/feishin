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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    blobKey,
    LocalMediaStore,
    mimeForContainer,
    targetKey,
} from '/@/renderer/cache/media-store';

// --- in-memory Dexie table shim ---------------------------------------

// Multi-entry (`*`-prefixed) indexes per the v9 mediaBlobs schema in db.ts.
// A multiEntry index expands an array-valued field into one index entry per
// element; a plain index yields one entry per row. `orderBy(index).keys()`
// must reproduce that so the Blob-free read paths in LocalMediaStore behave
// exactly as real Dexie would.
const MULTI_ENTRY: Record<string, Set<string>> = {
    mediaBlobs: new Set(['EntityKeys']),
};

class TableShim<T extends Record<string, any>> {
    readonly rows = new Map<unknown, T>();
    private readonly multiEntry: Set<string>;
    private readonly pk: string;

    constructor(pk: string, multiEntry: Set<string> = new Set()) {
        this.pk = pk;
        this.multiEntry = multiEntry;
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

    // Faithful to Dexie: `.each()` deserialises the WHOLE row (Blob included).
    // The Blob-free read paths must NOT route through here — tests spy on this
    // to prove the audio bytes are never materialised on those paths.
    async each(fn: (row: T) => void): Promise<void> {
        for (const row of this.rows.values()) fn(row);
    }

    async get(key: unknown): Promise<T | undefined> {
        return this.rows.get(key);
    }

    // Mirror Dexie's `Collection`: `.keys()` returns the INDEX keys (scalars),
    // never the rows — so no Blob is ever cloned. multiEntry indexes expand
    // array fields per element; scalar indexes emit one key per row.
    orderBy(field: string) {
        return {
            keys: async (): Promise<Array<number | string>> => {
                const out: Array<number | string> = [];
                for (const row of this.rows.values()) {
                    const v = row[field];
                    if (this.multiEntry.has(field)) {
                        if (Array.isArray(v)) {
                            for (const el of v) out.push(el);
                        }
                    } else if (v !== undefined) {
                        out.push(v);
                    }
                }
                return out;
            },
        };
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
    const mediaBlobs = new TableShim<CachedMediaBlob>('Key', MULTI_ENTRY.mediaBlobs);
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

    it('listSongKeys returns every downloaded blob key', async () => {
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's2',
        });
        const keys = await store.listSongKeys();
        expect(keys.sort()).toEqual(['srv:s1', 'srv:s2']);
    });

    it('totalBytes / listSongKeys / listAvailableEntityKeys never materialise blob rows', async () => {
        // The OOM fix: these three indicator-refresh paths run on every
        // availability/stats refresh (offline add/remove, each sync finish,
        // cold start). They MUST read index keys only — routing through
        // `.each()` (or any row read) structured-clones each row's audio Blob
        // into the heap, which on a multi-GB library is a real iOS OOM. We spy
        // on the shim's `.each()` to prove no row deserialisation occurs and on
        // `.orderBy().keys()` to prove the Blob-free index cursor IS used.
        // s1 belongs to two entities (dedup coverage); s2 is a distinct blob
        // so the byte sum and song-key set are non-trivial.
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(20),
            container: 'mp3',
            entityKey: 'srv:playlist:pl1',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(30),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's2',
        });

        const table = (db as any).mediaBlobs;
        const eachSpy = vi.spyOn(table, 'each');
        const orderBySpy = vi.spyOn(table, 'orderBy');

        const total = await store.totalBytes();
        const songKeys = await store.listSongKeys();
        const entityKeys = await store.listAvailableEntityKeys();

        // Correct results preserved (s1=10 + s2=30; s1's second save is
        // membership-only and adds no bytes).
        expect(total).toBe(40);
        expect(songKeys.sort()).toEqual(['srv:s1', 'srv:s2']);
        expect(entityKeys.sort()).toEqual(['srv:album:al1', 'srv:playlist:pl1']);

        // No row (and therefore no Blob) was ever read.
        expect(eachSpy).not.toHaveBeenCalled();
        // Each method drove a Blob-free index cursor.
        expect(orderBySpy).toHaveBeenCalledWith('ByteSize');
        expect(orderBySpy).toHaveBeenCalledWith('Key');
        expect(orderBySpy).toHaveBeenCalledWith('EntityKeys');
    });

    it('listAvailableEntityKeys returns each owning target once (deduped)', async () => {
        // s1 belongs to BOTH an album and a playlist; s2 only the album.
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'srv:playlist:pl1',
            serverId: 'srv',
            songId: 's1',
        });
        await store.save({
            blob: blob(10),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's2',
        });
        const keys = await store.listAvailableEntityKeys();
        expect(keys.sort()).toEqual(['srv:album:al1', 'srv:playlist:pl1']);
    });
});

describe('LocalMediaStore streaming (saveStreamed)', () => {
    let db: LibraryCacheDb;
    let storeFromUrl: ReturnType<typeof vi.fn>;
    let store: LocalMediaStore;

    beforeEach(() => {
        db = makeDb();
        // A fake backend that "streams" a URL to an fs ref without ever
        // materializing a Blob — the Android filesystem backend's shape.
        storeFromUrl = vi.fn(async (_ns: string, key: string) => ({
            ref: { kind: 'fs', path: `/vol/${key}`, volumeId: 'V' },
            size: 4242,
        }));
        const backend = {
            health: async () => ({ available: true }),
            id: 'capacitor-fs',
            load: async () => undefined,
            remove: async () => {},
            resolveUrl: () => undefined,
            store: async (_ns: string, key: string) => ({
                kind: 'fs',
                path: `/vol/${key}`,
                volumeId: 'V',
            }),
            storeFromUrl,
        };
        store = new LocalMediaStore(
            () => db,
            () => backend as any,
        );
    });

    it('supportsStreaming reflects the active backend', () => {
        expect(store.supportsStreaming()).toBe(true);
        // Default backend (idb, in the node test env) can't stream.
        expect(new LocalMediaStore(() => db).supportsStreaming()).toBe(false);
    });

    it('streams a new song to a row and reports it as new', async () => {
        const res = await store.saveStreamed({
            container: 'flac',
            entityKey: 'srv:artist:ar1',
            serverId: 'srv',
            songId: 's1',
            url: 'https://srv/dl/s1',
        });
        expect(res).toEqual({ isNew: true, size: 4242 });
        expect(storeFromUrl).toHaveBeenCalledWith('audio', 'srv:s1', 'https://srv/dl/s1', {
            signal: undefined,
        });
        const row = await store.get('srv', 's1');
        expect(row?.ByteSize).toBe(4242);
        expect(row?.Backend).toBe('capacitor-fs');
        expect(row?.Path).toBe('/vol/srv:s1');
        expect(row?.EntityKeys).toEqual(['srv:artist:ar1']);
    });

    it('dedups an already-downloaded song without hitting the network', async () => {
        await store.saveStreamed({
            container: 'flac',
            entityKey: 'srv:artist:ar1',
            serverId: 'srv',
            songId: 's1',
            url: 'https://srv/dl/s1',
        });
        storeFromUrl.mockClear();
        const res = await store.saveStreamed({
            container: 'flac',
            entityKey: 'srv:playlist:pl1',
            serverId: 'srv',
            songId: 's1',
            url: 'https://srv/dl/s1',
        });
        expect(res).toEqual({ isNew: false, size: 4242 });
        // No second download — just a membership reference.
        expect(storeFromUrl).not.toHaveBeenCalled();
        const row = await store.get('srv', 's1');
        expect(row?.EntityKeys).toEqual(['srv:artist:ar1', 'srv:playlist:pl1']);
        expect(await store.count()).toBe(1);
    });

    it('deleteBlobBytes drops a single song row', async () => {
        await store.saveStreamed({
            container: 'flac',
            entityKey: 'srv:artist:ar1',
            serverId: 'srv',
            songId: 's1',
            url: 'https://srv/dl/s1',
        });
        expect(await store.has('srv', 's1')).toBe(true);
        await store.deleteBlobBytes('srv', 's1');
        expect(await store.has('srv', 's1')).toBe(false);
        expect(await store.count()).toBe(0);
    });
});
