// Regression tests for cache coherence between db.favorites and the entity
// Payload (db.albums / db.songs / db.artists) on favorite/rating mutations.
//
// Bug: toggling a favorite or setting a rating wrote only db.favorites, which
// drives filters/sorts. Cache-served LIST rows render straight from
// db.<entity>.Payload, so the heart/stars on a row stayed stale until a hard
// refresh re-fetched from the server. The optimistic apply now patches the
// entity Payload too, and rollback restores it on a failed remote.
//
// We drive the op handlers' `apply`/`rollback` directly (via __testHandlers) so
// the queue worker — which would fire real remote calls — never runs. The DB is
// the REAL LibraryCacheDb against fake-indexeddb.

import 'fake-indexeddb/auto';
import type { CachedAlbum, CachedSong } from '/@/renderer/cache/types';
import type { Album, Song } from '/@/shared/types/domain-types';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LibraryCacheDb } from '/@/renderer/cache/db';
import { __testHandlers } from '/@/renderer/cache/mutations';
import { LibraryItem } from '/@/shared/types/domain-types';

let db: LibraryCacheDb;
let dbName = '';
let dbSeq = 0;

const albumRow = (id: string, userFavorite: boolean, userRating: null | number): CachedAlbum =>
    ({
        __cachedAt: 0,
        AlbumArtistId: 'artist-1',
        DateLastSaved: '',
        GenreIds: [],
        Id: id,
        Payload: { id, name: id, userFavorite, userRating } as unknown as Album,
        ProductionYear: undefined,
        SortName: id,
    }) satisfies CachedAlbum;

const songRow = (id: string, userFavorite: boolean): CachedSong =>
    ({
        __cachedAt: 0,
        AlbumArtistId: 'artist-1',
        AlbumId: 'album-1',
        DateLastSaved: '',
        Id: id,
        IndexNumber: 1,
        ParentIndexNumber: 1,
        Payload: { id, name: id, userFavorite, userRating: null } as unknown as Song,
    }) satisfies CachedSong;

const favoriteArgs = (id: string, type: LibraryItem) => ({
    apiClientProps: { serverId: 'server-1' },
    query: { id: [id], type },
});

const ratingArgs = (id: string, type: LibraryItem, rating: number) => ({
    apiClientProps: { serverId: 'server-1' },
    query: { id: [id], rating, type },
});

beforeEach(async () => {
    dbSeq += 1;
    dbName = `mutations-fav-payload-${dbSeq}`;
    db = new LibraryCacheDb(dbName);
    await db.open();
});

afterEach(async () => {
    db.close();
    await LibraryCacheDb.delete(dbName).catch(() => undefined);
});

describe('favorite/rating optimistic patches the entity Payload', () => {
    it('createFavorite flips db.albums Payload.userFavorite, not just db.favorites', async () => {
        await db.albums.put(albumRow('album-1', false, null));

        await __testHandlers.createFavorite.apply(db, favoriteArgs('album-1', LibraryItem.ALBUM));

        expect((await db.albums.get('album-1'))?.Payload.userFavorite).toBe(true);
        expect((await db.favorites.get(['album-1', 'Album']))?.IsFavorite).toBe(true);
    });

    it('deleteFavorite clears the album Payload favorite flag', async () => {
        await db.albums.put(albumRow('album-1', true, null));

        await __testHandlers.deleteFavorite.apply(db, favoriteArgs('album-1', LibraryItem.ALBUM));

        expect((await db.albums.get('album-1'))?.Payload.userFavorite).toBe(false);
    });

    it('createFavorite patches db.songs Payload for a song favorite', async () => {
        await db.songs.put(songRow('song-1', false));

        await __testHandlers.createFavorite.apply(db, favoriteArgs('song-1', LibraryItem.SONG));

        expect((await db.songs.get('song-1'))?.Payload.userFavorite).toBe(true);
    });

    it('setRating writes the rating onto db.albums Payload.userRating', async () => {
        await db.albums.put(albumRow('album-1', false, null));

        await __testHandlers.setRating.apply(db, ratingArgs('album-1', LibraryItem.ALBUM, 4));

        expect((await db.albums.get('album-1'))?.Payload.userRating).toBe(4);
    });

    it('setRating with 0 clears the Payload rating to null', async () => {
        await db.albums.put(albumRow('album-1', false, 5));

        await __testHandlers.setRating.apply(db, ratingArgs('album-1', LibraryItem.ALBUM, 0));

        expect((await db.albums.get('album-1'))?.Payload.userRating).toBeNull();
    });

    it('rollback restores the exact prior Payload after a failed remote', async () => {
        await db.albums.put(albumRow('album-1', false, 3));

        const snapshot = await __testHandlers.createFavorite.apply(
            db,
            favoriteArgs('album-1', LibraryItem.ALBUM),
        );
        expect((await db.albums.get('album-1'))?.Payload.userFavorite).toBe(true);

        await __testHandlers.createFavorite.rollback(db, snapshot);

        const restored = await db.albums.get('album-1');
        expect(restored?.Payload.userFavorite).toBe(false);
        // The unrelated field must survive the round-trip untouched.
        expect(restored?.Payload.userRating).toBe(3);
    });

    it('does not invent an entity row when none is cached', async () => {
        // No db.albums row seeded — apply must still succeed (favorites-only)
        // and must not fabricate a partial entity row.
        await __testHandlers.createFavorite.apply(db, favoriteArgs('ghost', LibraryItem.ALBUM));

        expect(await db.albums.get('ghost')).toBeUndefined();
        expect((await db.favorites.get(['ghost', 'Album']))?.IsFavorite).toBe(true);
    });
});
