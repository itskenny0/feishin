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
    // Optional: a row without a Blob is a negative-cache marker meaning
    // "we tried, the server returned 404 / no artwork at time MissAt".
    // The thumbnail resolver and sweep both treat such rows as
    // known-miss until MissAt ages out and a refetch is allowed.
    Blob: Blob | undefined;
    ByteSize: number;
    Etag: string | undefined;
    ItemId: string;
    LastUsed: number;
    // Set when the row was written as a negative-cache marker (a 404
    // from the server). Undefined on real blob rows.
    MissAt: number | undefined;
    // Metadata only: the pixel size we actually requested upstream when
    // the row was last written. Not part of the primary key — the cache
    // holds one blob per item at MAX_CACHE_SIZE and the browser
    // downscales for smaller display surfaces.
    Size?: number;
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

export interface SyncMetaRow {
    EntityType: EntityType;
    hydrationState: HydrationState;
    lastFullSyncAt: number | undefined;
    lastSweepAt: number | undefined;
    nextStartIndex: number | undefined;
    pausedUntil: number | undefined;
    totalCount: number | undefined;
}
