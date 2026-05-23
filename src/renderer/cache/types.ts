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
    Blob: Blob;
    ByteSize: number;
    Etag: string | undefined;
    ItemId: string;
    LastUsed: number;
    Size: number;
}

export type EntityType = 'albums' | 'artists' | 'favorites' | 'genres' | 'playlists' | 'songs';

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
