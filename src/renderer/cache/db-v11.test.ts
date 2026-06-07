// Migration test for Dexie schema v11: the `thumbnails` table is re-unified
// from a single `ItemId` primary key back to the compound `[ItemId+Variant]`
// key (one row per item × surface bucket). Because the thumbnail cache is
// fully rebuildable from the server, the upgrade CLEARS the table and drops
// the thumbnails `syncMeta` marker so the next launch re-runs the sweep.
//
// Unlike the lighter cache tests that drive an in-memory shim, this test
// exercises the REAL Dexie upgrade path (the `.upgrade()` callback only fires
// against a genuine IndexedDB), so it runs against `fake-indexeddb`.

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LibraryCacheDb } from '/@/renderer/cache/db';

// The v10 thumbnails schema (single `ItemId` PK). We stand up a bare Dexie at
// version 10 with just the tables this test touches, seed a row + the
// thumbnails sync marker, then close it and reopen via LibraryCacheDb (which
// declares up to v11) to trigger the upgrade.
const seedV10 = async (name: string): Promise<void> => {
    const legacy = new Dexie(name);
    legacy.version(10).stores({
        syncMeta: 'EntityType',
        thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
    });
    await legacy.open();
    await legacy.table('thumbnails').put({
        __cachedAt: Date.now(),
        Blob: undefined,
        ByteSize: 0,
        Etag: undefined,
        ItemId: 'album-1',
        LastUsed: Date.now(),
        MissAt: undefined,
        Size: 1024,
    });
    await legacy.table('syncMeta').put({
        EntityType: 'thumbnails',
        hydrationState: 'full',
        lastFullSyncAt: Date.now(),
        lastSweepAt: Date.now(),
        nextStartIndex: undefined,
        pausedUntil: undefined,
        totalCount: 1,
    });
    // Seed a non-thumbnail marker too, to prove the upgrade only drops the
    // thumbnails one.
    await legacy.table('syncMeta').put({
        EntityType: 'albums',
        hydrationState: 'full',
        lastFullSyncAt: Date.now(),
        lastSweepAt: Date.now(),
        nextStartIndex: undefined,
        pausedUntil: undefined,
        totalCount: 1,
    });
    legacy.close();
};

describe('Dexie v11 thumbnails migration', () => {
    const dbName = 'feishin-cache:test-server:test-user';

    beforeEach(() => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
    });

    afterEach(async () => {
        await Dexie.delete(dbName);
        vi.restoreAllMocks();
    });

    it('rekeys thumbnails to [ItemId+Variant]', async () => {
        await seedV10(dbName);

        const db = new LibraryCacheDb(dbName);
        await db.open();

        // The rekey is implemented as a delete-then-recreate across v11
        // (drop the single-keyed table) and v12 (recreate compound), because
        // Dexie can't change a primary key in a single version. The resulting
        // schema is the artwork-variant `[ItemId+Variant]` key.
        expect(db.verno).toBe(12);
        expect(db.table('thumbnails').schema.primKey.keyPath).toEqual(['ItemId', 'Variant']);

        db.close();
    });

    it('clears the old thumbnails rows on migrate', async () => {
        await seedV10(dbName);

        const db = new LibraryCacheDb(dbName);
        await db.open();

        const count = await db.table('thumbnails').count();
        expect(count).toBe(0);

        db.close();
    });

    it('drops the thumbnails syncMeta marker so the sweep re-runs', async () => {
        await seedV10(dbName);

        const db = new LibraryCacheDb(dbName);
        await db.open();

        const thumbMarker = await db.table('syncMeta').get('thumbnails');
        expect(thumbMarker).toBeUndefined();
        // Other entity markers are untouched.
        const albumMarker = await db.table('syncMeta').get('albums');
        expect(albumMarker).toBeDefined();

        db.close();
    });

    it('logs the v11 rekey on migrate', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        await seedV10(dbName);

        const db = new LibraryCacheDb(dbName);
        await db.open();

        expect(info).toHaveBeenCalledWith(
            expect.stringContaining('thumbnails v11: rekeyed to [ItemId+Variant]'),
        );

        db.close();
    });

    it('accepts compound-keyed writes after migrate', async () => {
        await seedV10(dbName);

        const db = new LibraryCacheDb(dbName);
        await db.open();

        await db.table('thumbnails').put({
            __cachedAt: Date.now(),
            Blob: undefined,
            ByteSize: 0,
            Etag: undefined,
            Format: 'webp',
            ItemId: 'album-1',
            LastUsed: Date.now(),
            MissAt: undefined,
            Size: 80,
            Variant: 'table',
        });
        await db.table('thumbnails').put({
            __cachedAt: Date.now(),
            Blob: undefined,
            ByteSize: 0,
            Etag: undefined,
            Format: 'webp',
            ItemId: 'album-1',
            LastUsed: Date.now(),
            MissAt: undefined,
            Size: 300,
            Variant: 'itemCard',
        });

        // Same ItemId, different Variant => two distinct rows.
        expect(await db.table('thumbnails').count()).toBe(2);
        const row = await db.table('thumbnails').get(['album-1', 'table']);
        expect(row?.Variant).toBe('table');
        expect(row?.Format).toBe('webp');

        db.close();
    });
});
