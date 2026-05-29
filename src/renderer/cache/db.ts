import type { EntityTable, Table } from 'dexie';

import Dexie from 'dexie';

import type {
    CachedAlbum,
    CachedArtist,
    CachedFavorite,
    CachedGenre,
    CachedLyrics,
    CachedMediaBlob,
    CachedPlaylist,
    CachedPlaylistSong,
    CachedSong,
    CachedThumbnail,
    CachedTrackmap,
    MutationRow,
    OfflineTargetRow,
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
    // Offline-media audio blob store. Keyed by `${serverId}:${songId}` so a
    // single Dexie DB (already per server+user) can still namespace cleanly.
    mediaBlobs!: EntityTable<CachedMediaBlob, 'Key'>;
    mutationQueue!: EntityTable<MutationRow, 'id'>;
    // Entities the user has marked for offline download (albums / playlists /
    // artists / genres / individual songs).
    offlineTargets!: EntityTable<OfflineTargetRow, 'Key'>;
    playlists!: EntityTable<CachedPlaylist, 'Id'>;
    playlistSongs!: Table<CachedPlaylistSong, [string, number]>;
    songs!: EntityTable<CachedSong, 'Id'>;
    syncMeta!: EntityTable<SyncMetaRow, 'EntityType'>;
    thumbnails!: EntityTable<CachedThumbnail, 'ItemId'>;
    // Lazily-generated trackmap spectrum analyses. Compound primary key
    // `[SongId+Sensitivity+Version]` (see CachedTrackmap). Never populated by
    // the sync sweep — written only on first play/visualise of a song.
    trackmaps!: Table<CachedTrackmap, [string, number, number]>;

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
                // Also drop the thumbnails sync-meta row so the next
                // launch doesn't see hydrationState: 'full' against an
                // empty table and skip the re-sync. Without this the
                // thumbnails table stays empty until the daily auto
                // resync fires.
                try {
                    await tx.table('syncMeta').delete('thumbnails');
                } catch (err) {
                    console.warn('[cache] v4 upgrade: syncMeta.delete(thumbnails) failed', err);
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

        // v7: add multi-entry `*GenreIds` index to albums so the featured-genres
        // home-page tiles can look up a genre-matching album with an O(log n) index
        // scan instead of a full db.albums.toArray() + JavaScript find(). The `*`
        // prefix tells Dexie to index each element of the string[] array separately.
        // Purely additive; existing rows get an empty [] for GenreIds and are never
        // matched by the genre query — they become correct once the next sweep/write
        // populates the field.
        this.version(7).stores({
            albums: 'Id, AlbumArtistId, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, *GenreIds, __cachedAt',
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

        // v8: add standalone `ItemType` index to favorites so
        // `where('ItemType').equals('Album')` runs as an O(log n) index
        // scan. Previously ItemType only existed in the compound primary
        // key `[ItemId+ItemType]`, which Dexie cannot address as a
        // standalone field — every list query that filtered by favorite
        // fell back to `.filter()` (a full JS-side row walk). On a 50k
        // library with thousands of favorites that's the second-largest
        // per-list cost after the table-scan. Purely additive; existing
        // rows already carry ItemType so the index populates immediately
        // without a row-copy migration.
        this.version(8).stores({
            albums: 'Id, AlbumArtistId, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, *GenreIds, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], ItemType, IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, AlbumId, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
        });

        // v9: additive — adds the offline-media audio layer. Two new stores:
        //
        //  - `mediaBlobs`: the downloaded audio blobs. Primary key `Key` is
        //    `${serverId}:${songId}`. `SongId` is indexed for a direct
        //    has()/get() by song id (the playback substitution path), the
        //    multi-entry `*EntityKeys` index lets us list/evict every blob
        //    belonging to an offline target (an album / playlist / artist /
        //    genre may share songs, so a blob can belong to several targets),
        //    and `ByteSize` is indexed so totalBytes() can sum without a full
        //    structured-clone of every blob row.
        //  - `offlineTargets`: the user's offline wishlist. Primary key `Key`
        //    is `${serverId}:${entityType}:${entityId}`. `EntityType` and
        //    `Status` are indexed for the settings list.
        //
        // Every existing v8 store is re-declared identically so Dexie performs
        // zero row-copy work; the two new tables start empty.
        this.version(9).stores({
            albums: 'Id, AlbumArtistId, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, *GenreIds, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], ItemType, IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mediaBlobs: 'Key, SongId, *EntityKeys, ByteSize, DownloadedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            offlineTargets: 'Key, EntityType, Status, AddedAt',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, AlbumId, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
        });

        // v10: additive — adds the `trackmaps` store for the lazily-generated
        // spectrum analyses. Compound primary key `[SongId+Sensitivity+Version]`
        // so multiple sensitivity settings coexist and a TRACKMAP_DATA_VERSION
        // bump turns every prior row into a natural cache miss (forcing
        // re-analysis with the new algorithm rather than serving a stale blob).
        // `SongId` is indexed for a direct lookup/delete by song, `LastUsed`
        // powers the LRU eviction pass, and `ByteSize` lets the eviction pass
        // sum sizes via the index keys without materialising every Bins buffer.
        // CRITICAL: this table is NEVER written by the library sync sweep — it
        // is populated only when a song is actually played/visualised. Every
        // existing v9 store is re-declared identically so Dexie performs zero
        // row-copy work; the new table starts empty.
        this.version(10).stores({
            albums: 'Id, AlbumArtistId, [AlbumArtistId+SortName], DateLastSaved, SortName, ProductionYear, *GenreIds, __cachedAt',
            artists: 'Id, SortName, Name, DateLastSaved, Kind, __cachedAt',
            favorites:
                '[ItemId+ItemType], ItemType, IsFavorite, Rating, LastPlayedDate, PlayCount, __cachedAt',
            genres: 'Id, SortName, Name, __cachedAt',
            lyrics: 'SongId, __cachedAt',
            mediaBlobs: 'Key, SongId, *EntityKeys, ByteSize, DownloadedAt',
            mutationQueue: 'id, status, createdAt, idempotencyKey',
            offlineTargets: 'Key, EntityType, Status, AddedAt',
            playlists: 'Id, SortName, DateLastSaved, __cachedAt',
            playlistSongs: '[PlaylistId+ListOrder], PlaylistId, SongId, __cachedAt',
            songs: 'Id, AlbumId, [AlbumId+ParentIndexNumber+IndexNumber], AlbumArtistId, DateLastSaved, [AlbumId+IndexNumber], __cachedAt',
            syncMeta: 'EntityType',
            thumbnails: 'ItemId, LastUsed, ByteSize, MissAt, __cachedAt',
            trackmaps: '[SongId+Sensitivity+Version], SongId, LastUsed, ByteSize, __cachedAt',
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
