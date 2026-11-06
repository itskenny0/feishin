// Existing installs stopped syncing albums + songs at ~1000 rows (suppressed
// count) and cached songs album-first (no cover identity). The one-shot rewinds
// both to a full pass exactly once per DB, and starts it right away unless the
// first-sync gate still owns hydration.

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    firstSyncComplete: {} as Record<string, unknown>,
    hydrate: vi.fn(async () => undefined),
}));

vi.mock('./sync', () => ({ hydrate: mocks.hydrate }));
vi.mock('/@/renderer/store', () => ({
    useSettingsStore: {
        getState: () => ({ localCache: { firstSyncComplete: mocks.firstSyncComplete } }),
    },
}));

import { LibraryCacheDb } from './db';
import { LIBRARY_RESYNC_FLAG, scheduleLibraryResyncOnce } from './library-resync-once';
import { useCacheStore } from './store';

const DB_NAME = 'feishin-cache:library-resync:user';
const SERVER = { id: 'srv1', type: 'jellyfin' } as never;

const fullSongsMeta = {
    EntityType: 'songs' as const,
    hydrationState: 'full' as const,
    lastFullSyncAt: 1_000,
    lastSweepAt: 1_000,
    nextStartIndex: 0,
    pausedUntil: undefined,
    totalCount: 2,
};

const seedSong = (db: LibraryCacheDb, id: string) =>
    db.songs.put({
        __cachedAt: 1,
        AlbumArtistId: undefined,
        AlbumId: 'album-1',
        DateLastSaved: '',
        Id: id,
        IndexNumber: 1,
        ParentIndexNumber: 1,
        Payload: { id } as never,
    });

let db: LibraryCacheDb;

beforeEach(async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    mocks.firstSyncComplete = { srv1: { at: 1, partial: false } };
    db = new LibraryCacheDb(DB_NAME);
    await db.open();
});

afterEach(async () => {
    db.close();
    await Dexie.delete(DB_NAME);
    vi.restoreAllMocks();
    mocks.hydrate.mockClear();
});

describe('scheduleLibraryResyncOnce', () => {
    it('rewinds a fully synced song table to a full pass and starts it', async () => {
        await seedSong(db, 's1');
        await db.syncMeta.put(fullSongsMeta);

        await scheduleLibraryResyncOnce(db, SERVER);

        const meta = await db.syncMeta.get('songs');
        expect(meta?.hydrationState).toBe('partial');
        expect(meta?.nextStartIndex).toBe(0);
        // The cursor rewinds but the sync history survives.
        expect(meta?.lastFullSyncAt).toBe(1_000);
        expect(meta?.totalCount).toBe(2);
        expect(useCacheStore.getState().hydrationStates.songs).toBe('partial');
        expect(mocks.hydrate).toHaveBeenCalledWith(SERVER, 'full');
        expect(await db.syncMeta.get(LIBRARY_RESYNC_FLAG as never)).toBeDefined();
    });

    it('rewinds albums too, and only entities that have cached rows', async () => {
        await db.albums.put({
            __cachedAt: 1,
            AlbumArtistId: '',
            DateLastSaved: '',
            GenreIds: [],
            Id: 'album-1',
            Payload: { id: 'album-1' } as never,
            ProductionYear: undefined,
            SortName: 'a',
        });
        await db.syncMeta.put({ ...fullSongsMeta, EntityType: 'albums' });

        await scheduleLibraryResyncOnce(db, SERVER);

        const albums = await db.syncMeta.get('albums');
        expect(albums?.hydrationState).toBe('partial');
        expect(albums?.nextStartIndex).toBe(0);
        expect(await db.syncMeta.get('songs')).toBeUndefined();
        expect(mocks.hydrate).toHaveBeenCalledWith(SERVER, 'full');
    });

    it('runs only once per DB', async () => {
        await seedSong(db, 's1');
        await db.syncMeta.put(fullSongsMeta);
        await scheduleLibraryResyncOnce(db, SERVER);
        await db.syncMeta.put(fullSongsMeta);
        mocks.hydrate.mockClear();

        await scheduleLibraryResyncOnce(db, SERVER);

        expect((await db.syncMeta.get('songs'))?.hydrationState).toBe('full');
        expect(mocks.hydrate).not.toHaveBeenCalled();
    });

    it('only stamps the flag on a DB with nothing cached', async () => {
        await scheduleLibraryResyncOnce(db, SERVER);

        expect(await db.syncMeta.get('songs')).toBeUndefined();
        expect(await db.syncMeta.get(LIBRARY_RESYNC_FLAG as never)).toBeDefined();
        expect(mocks.hydrate).not.toHaveBeenCalled();
    });

    it('leaves starting the pass to the first-sync gate while it is blocking', async () => {
        mocks.firstSyncComplete = {};
        await seedSong(db, 's1');
        await db.syncMeta.put({ ...fullSongsMeta, hydrationState: 'partial', nextStartIndex: 500 });

        await scheduleLibraryResyncOnce(db, SERVER);

        expect((await db.syncMeta.get('songs'))?.nextStartIndex).toBe(0);
        expect(mocks.hydrate).not.toHaveBeenCalled();
    });
});
