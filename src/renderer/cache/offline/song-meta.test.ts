import 'fake-indexeddb/auto';
import type { Song } from '/@/shared/types/domain-types';

import { beforeEach, describe, expect, it } from 'vitest';

import type { CachedSong } from '../types';

import { LibraryCacheDb } from '../db';
import { cacheOfflineSongMeta } from './song-meta';

const song = (id: string): Song =>
    ({
        albumArtists: [],
        albumId: 'al1',
        container: 'flac',
        discNumber: 1,
        id,
        name: id,
        size: 1,
        trackNumber: 1,
        updatedAt: '2026-01-01',
    }) as unknown as Song;

let seq = 0;
describe('cacheOfflineSongMeta', () => {
    let db: LibraryCacheDb;
    beforeEach(async () => {
        db = new LibraryCacheDb(`meta-${(seq += 1)}`);
        await db.open();
        await db.songs.clear();
    });

    it('inserts metadata rows for songs missing from db.songs', async () => {
        await cacheOfflineSongMeta([song('s1'), song('s2')], db);
        expect(await db.songs.get('s1')).toBeTruthy();
        expect((await db.songs.get('s2'))?.Payload?.id).toBe('s2');
    });

    it('does not clobber an existing row', async () => {
        const existing: CachedSong = {
            __cachedAt: 111,
            AlbumArtistId: undefined,
            AlbumId: 'al1',
            DateLastSaved: '',
            Id: 's1',
            IndexNumber: undefined,
            ParentIndexNumber: undefined,
            Payload: song('s1'),
        };
        await db.songs.put(existing);
        await cacheOfflineSongMeta([song('s1')], db);
        expect((await db.songs.get('s1'))?.__cachedAt).toBe(111); // untouched
    });
});
