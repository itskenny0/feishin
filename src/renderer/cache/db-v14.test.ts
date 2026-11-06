// Migration test for Dexie schema v14: an additive, sparse `OwnCoverId` index
// on `songs`. Existing rows survive untouched; only rows that carry the field
// (songs with distinct own art) appear in the index, which is what lets the
// thumbnail sweep enumerate them key-only.

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it } from 'vitest';

import { LibraryCacheDb } from '/@/renderer/cache/db';

const SONGS_V13 =
    'Id, AlbumId, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt';

const songRow = (id: string, extra: Record<string, unknown> = {}) => ({
    __cachedAt: 1,
    AlbumArtistId: 'aa1',
    AlbumId: 'album-1',
    DateLastSaved: '',
    Id: id,
    IndexNumber: 1,
    ParentIndexNumber: 1,
    Payload: { id },
    ...extra,
});

describe('Dexie v14 songs OwnCoverId index', () => {
    const dbName = 'feishin-cache:test-server-v14:test-user';

    afterEach(async () => {
        await Dexie.delete(dbName);
    });

    it('adds the index without touching existing song rows', async () => {
        const legacy = new Dexie(dbName);
        legacy.version(13).stores({ songs: SONGS_V13 });
        await legacy.open();
        await legacy.table('songs').put(songRow('song-old'));
        legacy.close();

        const db = new LibraryCacheDb(dbName);
        await db.open();

        expect(db.verno).toBeGreaterThanOrEqual(14);
        expect(db.songs.schema.idxByName.OwnCoverId).toBeDefined();
        expect((await db.songs.get('song-old'))?.Payload).toEqual({ id: 'song-old' });
        // Legacy rows lack the field, so they stay out of the sparse index.
        expect(await db.songs.orderBy('OwnCoverId').uniqueKeys()).toEqual([]);

        db.close();
    });

    it('enumerates only songs that carry an OwnCoverId', async () => {
        const db = new LibraryCacheDb(dbName);
        await db.open();
        await db.songs.bulkPut([
            songRow('song-a', { OwnCoverId: 'song-a' }),
            songRow('song-b', { OwnCoverId: undefined }),
            songRow('song-c', { OwnCoverId: 'song-c' }),
        ] as never);

        expect(await db.songs.orderBy('OwnCoverId').uniqueKeys()).toEqual(['song-a', 'song-c']);

        db.close();
    });
});
