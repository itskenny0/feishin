// Cache row converters — share the mapping between a server-side payload
// and the Dexie row shape across feature/api factories and the in-feature
// cached query hooks. Both paths need to write to the same Dexie tables
// with consistent shapes, but they live in different feature directories;
// keeping the mappers in the cache module is the easiest single source of
// truth.

import type {
    CachedAlbum,
    CachedArtist,
    CachedGenre,
    CachedPlaylist,
    CachedSong,
} from './types';
import type { Album, AlbumArtist, Artist, Genre, Playlist, Song } from '/@/shared/types/domain-types';

const nowMs = (): number => Date.now();

export const toCachedAlbumRow = (album: Album): CachedAlbum => ({
    __cachedAt: nowMs(),
    AlbumArtistId: album.albumArtists?.[0]?.id ?? '',
    DateLastSaved: album.updatedAt ?? '',
    Id: album.id,
    Payload: album,
    ProductionYear: album.releaseYear ?? undefined,
    SortName: album.sortName ?? (album.name ?? '').toLowerCase(),
});

export const toCachedArtistRow = (
    artist: AlbumArtist | Artist,
    kind: 'AlbumArtist' | 'Artist',
): CachedArtist => ({
    __cachedAt: nowMs(),
    DateLastSaved:
        (artist as { updatedAt?: string }).updatedAt ?? '',
    Id: artist.id,
    Kind: kind,
    Name: artist.name,
    Payload: artist as AlbumArtist,
    SortName: (artist.name ?? '').toLowerCase(),
});

export const toCachedSongRow = (song: Song): CachedSong => ({
    __cachedAt: nowMs(),
    AlbumArtistId: song.albumArtists?.[0]?.id,
    AlbumId: song.albumId,
    DateLastSaved: song.updatedAt ?? '',
    Id: song.id,
    IndexNumber: song.trackNumber,
    ParentIndexNumber: song.discNumber,
    Payload: song,
});

export const toCachedPlaylistRow = (playlist: Playlist): CachedPlaylist => ({
    __cachedAt: nowMs(),
    // Navidrome/Subsonic surface an `updatedAt` field on Playlist that
    // isn't in the canonical type; pull it through anyway so the cache
    // can answer sort-by-updatedAt queries without having to fall back
    // to the network.
    DateLastSaved: (playlist as { updatedAt?: string }).updatedAt ?? '',
    Id: playlist.id,
    Payload: playlist,
    SortName: (playlist.name ?? '').toLowerCase(),
});

export const toCachedGenreRow = (genre: Genre): CachedGenre => ({
    __cachedAt: nowMs(),
    Id: genre.id,
    Name: genre.name,
    Payload: genre,
    SortName: (genre.name ?? '').toLowerCase(),
});
