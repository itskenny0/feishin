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
    thumbnails!: Table<CachedThumbnail, [string, number]>;

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
    }
}
const handles = new Map<Key, LibraryCacheDb>();
let active: undefined | { db: LibraryCacheDb; key: Key };

const dbName = (serverId: string, userId: string): string => `feishin-cache:${serverId}:${userId}`;

const keyFor = (serverId: string, userId: string): Key => `${serverId}:${userId}`;

/**
 * Open (or reuse) the cache DB for a (serverId, userId) pair. Returns
 * undefined if IndexedDB is unavailable on this platform.
 */
export const openCacheDb = async (
    serverId: string,
    userId: string,
): Promise<LibraryCacheDb | undefined> => {
    if (!(await isCacheAvailable())) return undefined;

    const k = keyFor(serverId, userId);
    let db = handles.get(k);
    if (!db) {
        db = new LibraryCacheDb(dbName(serverId, userId));
        await db.open();
        handles.set(k, db);
    }
    active = { db, key: k };
    return db;
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
