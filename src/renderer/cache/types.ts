// Row types persisted in the Dexie cache DB. Every row carries the
// originating Jellyfin Payload so we can re-render the existing UI
// components without any translation step — they were designed to consume
// the domain-types shapes, and we preserve them. Indexed fields are
// promoted to top-level columns so Dexie can build efficient indexes on
// them.

import type { Album, AlbumArtist, Genre, Playlist, Song } from '/@/shared/types/domain-types';

export type ArtistKind = 'AlbumArtist' | 'Artist';

export interface CachedAlbum extends CachedBase {
    AlbumArtistId: string;
    DateLastSaved: string;
    // Multi-entry indexed column: Dexie indexes each element separately so
    // `where('GenreIds').equals(genreId)` runs as an O(log n) index scan
    // rather than a full table scan.
    GenreIds: string[];
    Id: string;
    Payload: Album;
    ProductionYear: number | undefined;
    SortName: string;
}

export interface CachedArtist extends CachedBase {
    AlbumArtistId?: string;
    DateLastSaved: string;
    Id: string;
    Kind: ArtistKind;
    Name: string;
    Payload: AlbumArtist;
    SortName: string;
}

export interface CachedBase {
    __cachedAt: number;
}

export interface CachedFavorite extends CachedBase {
    IsFavorite: boolean;
    ItemId: string;
    ItemType: CachedFavoriteKind;
    LastPlayedDate: string | undefined;
    PlayCount: number;
    Rating: number | undefined;
}

export type CachedFavoriteKind = 'Album' | 'AlbumArtist' | 'Artist' | 'Playlist' | 'Song';

export interface CachedGenre extends CachedBase {
    Id: string;
    Name: string;
    Payload: Genre;
    SortName: string;
}

export interface CachedLyrics extends CachedBase {
    Lyrics: string;
    // Optional structured payload — the full `FullLyricsMetadata` blob from
    // the server / IPC layer. Stored as JSON so the lyrics surface can
    // reconstruct artist/source/synced state from cache without making a
    // network call. Older rows written before this field was introduced
    // simply have Payload === undefined and the caller falls back to the
    // legacy `Lyrics` + `Synced` columns.
    Payload?: import('/@/shared/types/domain-types').FullLyricsMetadata;
    SongId: string;
    Synced: boolean;
}

/**
 * A downloaded audio blob for offline playback. One row per (server, song).
 * The same blob can belong to several offline targets (e.g. a song is on an
 * album AND in a playlist the user both marked offline), so membership is
 * tracked via the multi-entry `EntityKeys` array rather than a single owner.
 */
export interface CachedMediaBlob {
    // Which blob backend owns the bytes. Undefined/'idb' = inline Blob (the
    // historical layout); 'capacitor-fs' = bytes live in a file at `Path`.
    Backend?: 'capacitor-fs' | 'idb';
    // Decoded audio bytes. Present only on the idb backend; undefined when the
    // bytes live on the filesystem (see `Path`).
    Blob?: Blob;
    ByteSize: number;
    // Container/extension hint (e.g. 'flac', 'mp3') — drives the blob MIME so
    // the web-audio engine picks the right decoder.
    Container: string | undefined;
    DownloadedAt: number;
    // Multi-entry index: every offline-target key (`${serverId}:${entityType}:${entityId}`)
    // that pulled this song in. Eviction by entity removes the entity key here
    // and only deletes the blob row once no target references it anymore.
    EntityKeys: string[];
    // `${serverId}:${songId}`.
    Key: OfflineKey;
    MimeType: string | undefined;
    // Absolute file path of the bytes on the filesystem backend. Undefined on
    // the idb backend.
    Path?: string;
    ServerId: string;
    SongId: string;
    // Id of the storage volume `Path` lives on (see active-backend). Undefined
    // on the idb backend.
    VolumeId?: string;
}

export interface CachedPlaylist extends CachedBase {
    DateLastSaved: string;
    Id: string;
    Payload: Playlist;
    SortName: string;
}

export interface CachedPlaylistSong extends CachedBase {
    ListOrder: number;
    PlaylistId: string;
    SongId: string;
    SongPayload: Song;
}

export interface CachedSong extends CachedBase {
    AlbumArtistId: string | undefined;
    AlbumId: string | undefined;
    DateLastSaved: string;
    Id: string;
    IndexNumber: number | undefined;
    ParentIndexNumber: number | undefined;
    Payload: Song;
}

export interface CachedThumbnail extends CachedBase {
    // Fingerprint of the `localCache.imageVariants` config in effect when this
    // row was written (see `variantConfigHash`). The resolver compares it to
    // the live config's hash and treats a mismatch as stale — a px / format /
    // quality / mode / enable change regenerates the cover lazily on next
    // access. Undefined on legacy rows written before config-hash staleness was
    // introduced; those are honoured as-is (no upgrade-time re-fetch stampede).
    __cfgHash?: string;
    // Which blob backend owns the bytes. Undefined/'idb' = inline Blob;
    // 'capacitor-fs' = bytes live in a file at `Path`. Negative-cache markers
    // (no bytes) leave this undefined.
    Backend?: 'capacitor-fs' | 'idb';
    // Optional: a row without a Blob is a negative-cache marker meaning
    // "we tried, the server returned 404 / no artwork at time MissAt".
    // The thumbnail resolver and sweep both treat such rows as
    // known-miss until MissAt ages out and a refetch is allowed.
    // On the filesystem backend the bytes live at `Path` instead of inline.
    Blob: Blob | undefined;
    ByteSize: number;
    Etag: string | undefined;
    // Encoding of the stored blob. In downscale mode covers are re-encoded
    // to WebP (with an automatic JPEG fallback when the webview can't
    // produce WebP); in download mode the server bytes are stored as-is
    // (treated as 'jpeg' for accounting). Part of the row payload, not the
    // key. Optional on legacy/negative-cache rows written before v11.
    Format?: 'jpeg' | 'webp';
    ItemId: string;
    LastUsed: number;
    // Set when the row was written as a negative-cache marker (a 404
    // from the server). Undefined on real blob rows.
    MissAt: number | undefined;
    // Absolute file path of the bytes on the filesystem backend. Undefined on
    // the idb backend and on negative-cache markers.
    Path?: string;
    // The actual stored pixel size for this variant (the longest edge after
    // downscale, or 0 for the original/full-size variant). Metadata only —
    // the variant bucket, not Size, is part of the primary key.
    Size?: number;
    // Surface bucket this row was cached for (`table`, `itemCard`, `sidebar`,
    // `header`, `fullScreen`). Together with `ItemId` it forms the compound
    // primary key `[ItemId+Variant]` introduced in schema v11, so the cache
    // holds one blob per (item, surface) at that surface's target px.
    Variant: string;
    // Id of the storage volume `Path` lives on. Undefined on the idb backend.
    VolumeId?: string;
}

/**
 * A lazily-generated trackmap (intensity-spectrum) analysis result for one
 * song at one sensitivity setting. Generated ONLY the first time a song is
 * played/visualised — never pre-generated during the library sync sweep —
 * then cached here so subsequent plays skip the (expensive) decode + DSP pass.
 *
 * Primary key is the compound `[SongId+Sensitivity+Version]`:
 *   - `SongId` namespaces per track (the cache DB is already per server+user,
 *     so the song id alone is unambiguous within a single DB).
 *   - `Sensitivity` is the user-tunable analysis knob — changing it produces a
 *     visually different curve, so each value gets its own row.
 *   - `Version` is the algorithm/output-format version (TRACKMAP_DATA_VERSION).
 *     Bumping it makes every prior row a natural cache miss, forcing re-analysis
 *     with the new algorithm rather than serving a stale-shaped blob.
 */
export interface CachedTrackmap extends CachedBase {
    // The intensity bins (length = TRACKMAP_BIN_COUNT, values in [0,1]). Stored
    // as a Float32Array — IndexedDB's structured clone round-trips typed arrays
    // losslessly, so no JSON stringify/parse is needed.
    Bins: Float32Array;
    // Bytes occupied by `Bins` (Float32Array.byteLength). Promoted to a top-
    // level indexed column so the eviction pass can sum sizes via the index
    // keys without materialising every Bins buffer.
    ByteSize: number;
    // Date.now() when the analysis was computed — debugging only.
    ComputedAt: number;
    // Decoded audio duration in ms (may differ from song metadata duration).
    DurationMs: number;
    // LRU timestamp — bumped on every cache hit so the eviction pass drops the
    // least-recently-played analyses first.
    LastUsed: number;
    // The analysis sensitivity knob this row was computed at.
    Sensitivity: number;
    SongId: string;
    // TRACKMAP_DATA_VERSION at write time.
    Version: number;
}

export type EntityType =
    | 'albums'
    | 'artists'
    | 'favorites'
    | 'genres'
    | 'playlists'
    | 'songs'
    | 'thumbnails';

export type HydrationState = 'full' | 'lazy' | 'none' | 'partial';

export type MutationOp =
    | 'addToPlaylist'
    | 'createFavorite'
    | 'createPlaylist'
    | 'deleteFavorite'
    | 'deletePlaylist'
    | 'incrementPlayCount'
    | 'removeFromPlaylist'
    | 'renamePlaylist'
    | 'reorderPlaylist'
    | 'setRating';

export interface MutationRow {
    args: unknown;
    attempts: number;
    createdAt: number;
    id: string;
    idempotencyKey: string;
    lastError: string | undefined;
    op: MutationOp;
    // Snapshot of pre-mutation rows for rollback. Shape is op-specific.
    snapshot: unknown;
    status: MutationStatus;
}

export type MutationStatus = 'failed' | 'in_progress' | 'pending';

export type OfflineEntityType = 'album' | 'artist' | 'genre' | 'playlist' | 'song';

export type OfflineKey = `${string}:${string}`;

/**
 * An entity the user marked for offline download. Primary key `Key` is
 * `${serverId}:${entityType}:${entityId}`.
 */
export interface OfflineTargetRow {
    AddedAt: number;
    // Total bytes of the blobs currently downloaded for this target.
    Bytes: number;
    // Number of blobs downloaded so far (<= SongCount).
    DownloadedCount: number;
    EntityId: string;
    EntityType: OfflineEntityType;
    Key: string;
    // Last error message if Status === 'error'.
    LastError: string | undefined;
    Name: string;
    ServerId: string;
    // Total songs enumerated for this entity (undefined until first sync).
    SongCount: number | undefined;
    Status: OfflineTargetStatus;
    UpdatedAt: number;
}

export type OfflineTargetStatus = 'complete' | 'error' | 'idle' | 'partial' | 'syncing';

export interface SyncMetaRow {
    EntityType: EntityType;
    hydrationState: HydrationState;
    lastFullSyncAt: number | undefined;
    lastSweepAt: number | undefined;
    nextStartIndex: number | undefined;
    pausedUntil: number | undefined;
    totalCount: number | undefined;
}
