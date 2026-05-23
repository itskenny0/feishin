import type { EntityTable, Table } from 'dexie';

import Dexie from 'dexie';

import type {
    CachedAlbum,
    CachedArtist,
    CachedFavorite,
    CachedGenre,
    CachedLyrics,
    CachedPlaylist,
    CachedPlaylistSong,
    CachedSong,
    CachedThumbnail,
    MutationRow,
    SyncMetaRow,
} from './types';

import { isCacheAvailable } from './capability';

type Key = `${string}:${string}`;

// Lifecycle ---------------------------------------------------------------

export class LibraryCacheDb extends Dexie {
    albums!: EntityTable<CachedAlbum, 'Id'>;
    artists!: EntityTable<CachedArtist, 'Id'>;
    // Compound-key tables use Dexie's lower-level Table<T, K> type because
    // EntityTable<T, K> requires K to be a single string-literal field name.
    favorites!: Table<CachedFavorite, [string, string]>;
    genres!: EntityTable<CachedGenre, 'Id'>;
    lyrics!: EntityTable<CachedLyrics, 'SongId'>;
    mutationQueue!: EntityTable<MutationRow, 'id'>;
    playlists!: EntityTable<CachedPlaylist, 'Id'>;
    playlistSongs!: Table<CachedPlaylistSong, [string, number]>;
    songs!: EntityTable<CachedSong, 'Id'>;
    syncMeta!: EntityTable<SyncMetaRow, 'EntityType'>;
    thumbnails!: EntityTable<CachedThumbnail, 'ItemId'>;

    constructor(name: string) {
        super(name);

        this.version(1).stores({
            albums: 'Id, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: '[ItemId+Size], LastUsed, ByteSize, __cachedAt',
        });

        // v2: additive — adds the `genres` store. Every existing v1 store is
        // re-declared identically so Dexie performs zero row-copy work. Rows
        // already persisted in v1 carry through to v2 untouched.
        this.version(2).stores({
            albums: 'Id, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: '[ItemId+Size], LastUsed, ByteSize, __cachedAt',
        });

        // v3: additive — indexes `MissAt` on the thumbnails table so we
        // can age negative-cache rows out of the table without a full
        // scan. Every existing v2 store is re-declared identically;
        // rows persisted in v2 carry through untouched. No row-copy
        // work runs because `MissAt` is a new optional field that
        // simply doesn't exist on the prior rows.
        this.version(3).stores({
            albums: 'Id, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: '[ItemId+Size], LastUsed, ByteSize, MissAt, __cachedAt',
        });

        // v4: thumbnails table is rekeyed from the compound `[ItemId+Size]`
        // to a single `ItemId` primary key. The cache now stores one blob
        // per item at MAX_CACHE_SIZE (see images.ts) and lets the browser
        // downscale for smaller display surfaces — this cuts the sweep
        // queue and Jellyfin-side resize cost by 5x. The .upgrade()
        // callback explicitly clears the existing thumbnails table so
        // Dexie doesn't try to migrate compound-keyed rows into a single-
        // keyed schema (which would either silently fail or get stuck
        // mid-transaction, leaving `getActiveCacheDb()` permanently
        // undefined and the dashboard reset buttons inoperable).
        this.version(4)
            .stores({
                albums: 'Id, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, __cachedAt',
                artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
                favorites:
                    '[ItemId+ItemType], IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
                genres: 'Id, SortName, Name, __cachedAt',
                lyrics: 'SongId, __cachedAt',
                mutationQueue: 'id, status, createdAt, idempotencyKey',
                playlists: 'Id, SortName, DateLastSaved, __cachedAt',
                playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
                songs: 'Id, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
                syncMeta: 'EntityType',
                thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
            })
            .upgrade(async (tx) => {
                try {
                    await tx.table('thumbnails').clear();
                } catch (err) {
                    console.warn('[cache] v4 upgrade: thumbnails.clear failed', err);
                }
            });

        // v5: add standalone `AlbumId` index to songs so `where('AlbumId').equals()`
        // works without Dexie throwing "Index not found". Previously AlbumId only
        // appeared in compound indexes ([AlbumId+ParentIndexNumber+IndexNumber] and
        // [AlbumId+IndexNumber]), which are not addressable via a single-field where().
        // No row-copy work — this is a purely additive index.
        this.version(5).stores({
            albums: 'Id, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, AlbumId, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
        });

        // v6: add standalone `AlbumArtistId` index to albums so `where('AlbumArtistId').equals()`
        // works when loading an artist's album list. Previously AlbumArtistId only appeared in
        // the compound index [AlbumArtistId+SortName], which Dexie cannot address as a standalone
        // field — it throws SchemaError caught silently, causing artist-album pages to always
        // fetch from the network instead of cache. Purely additive; no row-copy work.
        this.version(6).stores({
            albums: 'Id, AlbumArtistId, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, AlbumId, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
        });
    }
}
const handles = new Map<Key, LibraryCacheDb>();
let active: undefined | { db: LibraryCacheDb; key: Key };

const dbName = (serverId: string, userId: string): string => `feishin-cache:${serverId}:${userId}`;

const keyFor = (serverId: string, userId: string): Key => `${serverId}:${userId}`;

/**
 * Open (or reuse) the cache DB for a (serverId, userId) pair. Returns
 * undefined if IndexedDB is unavailable on this platform. Surfaces a
 * structured error to the caller so the lifecycle can present a
 * user-actionable "reset cache" prompt when a schema upgrade fails.
 */
export interface CacheDbOpenError {
    error: Error;
    serverId: string;
    userId: string;
}

let lastOpenError: CacheDbOpenError | undefined;

export const getLastOpenError = (): CacheDbOpenError | undefined => lastOpenError;

export const clearLastOpenError = (): void => {
    lastOpenError = undefined;
};

export const openCacheDb = async (
    serverId: string,
    userId: string,
): Promise<LibraryCacheDb | undefined> => {
    if (!(await isCacheAvailable())) return undefined;

    const k = keyFor(serverId, userId);
    let db = handles.get(k);
    if (!db) {
        db = new LibraryCacheDb(dbName(serverId, userId));
        try {
            await db.open();
        } catch (err) {
            console.warn('[cache] openCacheDb failed', { error: err, serverId, userId });
            lastOpenError = { error: err as Error, serverId, userId };
            return undefined;
        }
        handles.set(k, db);
    }
    active = { db, key: k };
    lastOpenError = undefined;
    return db;
};

/**
 * Hard-reset the cache DB for a (serverId, userId) pair. Unlike
 * `deleteCacheDb`, this can be called even when the DB handle is
 * permanently broken (e.g. a schema upgrade failed and `active` is
 * undefined). Closes any open handle first, then issues a raw
 * `indexedDB.deleteDatabase` so the next openCacheDb starts fresh.
 */
export const resetCacheDb = async (serverId: string, userId: string): Promise<void> => {
    const k = keyFor(serverId, userId);
    const existing = handles.get(k);
    if (existing) {
        try {
            existing.close();
        } catch {
            /* swallow */
        }
        handles.delete(k);
    }
    if (active?.key === k) active = undefined;
    try {
        await Dexie.delete(dbName(serverId, userId));
    } catch (err) {
        console.warn('[cache] resetCacheDb: Dexie.delete failed', err);
        if (typeof indexedDB !== 'undefined') {
            await new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(dbName(serverId, userId));
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
            });
        }
    }
    lastOpenError = undefined;
};

/**
 * Return the currently-active DB (i.e. the one matching the active
 * server+user). If none is active, returns undefined; callers must
 * defensively fall back to vanilla react-query in that case.
 */
export const getActiveCacheDb = (): LibraryCacheDb | undefined => active?.db;

/**
 * Close a specific DB and forget the handle. Used when the user removes
 * a server or signs out.
 */
export const closeCacheDb = async (serverId: string, userId: string): Promise<void> => {
    const k = keyFor(serverId, userId);
    const db = handles.get(k);
    if (db) {
        db.close();
        handles.delete(k);
    }
    if (active?.key === k) active = undefined;
};

/**
 * Delete the DB entirely. Used on `Clear cache → everything` and on
 * `deleteServer`.
 */
export const deleteCacheDb = async (serverId: string, userId: string): Promise<void> => {
    await closeCacheDb(serverId, userId);
    await Dexie.delete(dbName(serverId, userId));
};

/**
 * Switch the active DB. Closes nothing on its own — that's the caller's
 * job via closeCacheDb if appropriate. Returns the new active DB, or
 * undefined when no serverId/userId is provided.
 */
export const setActiveCacheDb = async (
    serverId: string | undefined,
    userId: string | undefined,
): Promise<LibraryCacheDb | undefined> => {
    if (!serverId || !userId) {
        active = undefined;
        return undefined;
    }
    return openCacheDb(serverId, userId);
};
