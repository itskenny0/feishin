// Local-first global search backed by fuse.js indexes built lazily from
// the Dexie tables. The indexes are constructed on the first searchLocal()
// call after init (and rebuilt whenever the underlying table is marked
// dirty), reused for the rest of the session.
//
// Index strategy
// --------------
// Each entity owns a single Fuse instance. The corpus is the full Dexie
// row set for that entity (artists are filtered to Kind === 'AlbumArtist',
// since the global search UI lists album artists). We index `Payload.name`
// and, for songs/albums, the leading album-artist name so a search for
// "beatles abbey" finds "Abbey Road" by the Beatles. The fuse threshold
// of 0.3 is intentionally tight; the global search is supposed to feel
// snappy and precise, not fuzzy-permissive.
//
// Dirty marking
// -------------
// Whenever a write-through path (hook `apply`) lands fresh rows in Dexie
// or a hydration sweep completes, callers invoke `markSearchDirty(entity)`.
// The next ensureXIndex() call rebuilds from the current Dexie contents.
// Rebuilds happen at most once per stale-marker, not per-row; the cost of
// rebuilding on every write would dominate the wall-clock budget.

import type { Album, AlbumArtist, Playlist, Song } from '/@/shared/types/domain-types';

import Fuse, { type IFuseOptions } from 'fuse.js';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import { markRowCacheDirty } from './local-cache';
import { useCacheStore } from './store';

export interface SearchLocalResult {
    albums: Album[];
    artists: AlbumArtist[];
    playlists: Playlist[];
    songs: Song[];
}

// Slim search-index entries. We hold a reference to the original Payload
// so result mapping is a single property read — but the Fuse index itself
// only walks the `name` / `artist` fields, which keeps the indexing cost
// proportional to the number of indexed bytes, not to the full row
// payload (artwork URLs, lyrics, genres array, etc).
interface AlbumSearchEntry {
    artist: string;
    name: string;
    payload: Album;
}

interface ArtistSearchEntry {
    name: string;
    payload: AlbumArtist;
}

type Entity = 'albums' | 'artists' | 'playlists' | 'songs';

interface PlaylistSearchEntry {
    name: string;
    payload: Playlist;
}

interface SongSearchEntry {
    artist: string;
    name: string;
    payload: Song;
}

// Per-entity index state. Each index is paired with a "dirty" flag so the
// next access rebuilds when the underlying rows have changed.
let albumsIndex: Fuse<AlbumSearchEntry> | undefined;
let albumsDirty = true;
let artistsIndex: Fuse<ArtistSearchEntry> | undefined;
let artistsDirty = true;
let playlistsIndex: Fuse<PlaylistSearchEntry> | undefined;
let playlistsDirty = true;
let songsIndex: Fuse<SongSearchEntry> | undefined;
let songsDirty = true;

// Fuse options operate on the projected slim entry, not the cached row.
// `keys` reference `name` / `artist` directly so Fuse never walks the
// Payload object — only the indexed strings.
const albumFuseOptions: IFuseOptions<AlbumSearchEntry> = {
    ignoreLocation: true,
    keys: [
        { name: 'name', weight: 0.7 },
        { name: 'artist', weight: 0.3 },
    ],
    threshold: 0.3,
    useExtendedSearch: false,
};

const artistFuseOptions: IFuseOptions<ArtistSearchEntry> = {
    ignoreLocation: true,
    keys: [{ name: 'name', weight: 1 }],
    threshold: 0.3,
    useExtendedSearch: false,
};

const playlistFuseOptions: IFuseOptions<PlaylistSearchEntry> = {
    ignoreLocation: true,
    keys: [{ name: 'name', weight: 1 }],
    threshold: 0.3,
    useExtendedSearch: false,
};

const songFuseOptions: IFuseOptions<SongSearchEntry> = {
    ignoreLocation: true,
    keys: [
        { name: 'name', weight: 0.6 },
        { name: 'artist', weight: 0.4 },
    ],
    threshold: 0.3,
    useExtendedSearch: false,
};

const ensureAlbumsIndex = async (): Promise<Fuse<AlbumSearchEntry> | undefined> => {
    if (albumsIndex && !albumsDirty) return albumsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.albums.toArray();
    const entries: AlbumSearchEntry[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        entries[i] = {
            artist: r.Payload.albumArtists?.[0]?.name ?? '',
            name: r.Payload.name ?? '',
            payload: r.Payload,
        };
    }
    albumsIndex = new Fuse(entries, albumFuseOptions);
    albumsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'albums',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return albumsIndex;
};

const ensureArtistsIndex = async (): Promise<Fuse<ArtistSearchEntry> | undefined> => {
    if (artistsIndex && !artistsDirty) return artistsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.artists.where('Kind').equals('AlbumArtist').toArray();
    const entries: ArtistSearchEntry[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        entries[i] = {
            name: r.Payload.name ?? '',
            payload: r.Payload,
        };
    }
    artistsIndex = new Fuse(entries, artistFuseOptions);
    artistsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'artists',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return artistsIndex;
};

const ensurePlaylistsIndex = async (): Promise<Fuse<PlaylistSearchEntry> | undefined> => {
    if (playlistsIndex && !playlistsDirty) return playlistsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.playlists.toArray();
    const entries: PlaylistSearchEntry[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        entries[i] = {
            name: r.Payload?.name ?? '',
            payload: r.Payload,
        };
    }
    playlistsIndex = new Fuse(entries, playlistFuseOptions);
    playlistsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'playlists',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return playlistsIndex;
};

const ensureSongsIndex = async (): Promise<Fuse<SongSearchEntry> | undefined> => {
    if (songsIndex && !songsDirty) return songsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.songs.toArray();
    const entries: SongSearchEntry[] = new Array(rows.length);
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        entries[i] = {
            artist: r.Payload.albumArtists?.[0]?.name ?? '',
            name: r.Payload.name ?? '',
            payload: r.Payload,
        };
    }
    songsIndex = new Fuse(entries, songFuseOptions);
    songsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'songs',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return songsIndex;
};

/**
 * Mark an entity's local search index as stale. The next call into
 * searchLocal() that touches that entity will rebuild it from the current
 * Dexie contents. Coarse-grained on purpose: write-through paths call this
 * once at the end of an `apply` rather than per-row, and a sweep completion
 * marks every affected entity at once.
 */
export const markSearchDirty = (entity: 'all' | Entity): void => {
    if (entity === 'all') {
        albumsDirty = true;
        artistsDirty = true;
        playlistsDirty = true;
        songsDirty = true;
        // Drop the in-memory row + sorted-result cache so the next list
        // read pulls fresh rows from Dexie. Without this, write-through
        // applies land in IndexedDB but the grids keep serving the
        // pre-write JS array.
        markRowCacheDirty('all');
        return;
    }
    if (entity === 'albums') {
        albumsDirty = true;
        markRowCacheDirty('albums');
    }
    if (entity === 'artists') {
        artistsDirty = true;
        // The artist Dexie row holds both Kinds; bump both row-cache
        // slots so AlbumArtist and Artist grids both see the new data.
        markRowCacheDirty('albumArtists');
        markRowCacheDirty('artists');
    }
    if (entity === 'playlists') playlistsDirty = true;
    if (entity === 'songs') {
        songsDirty = true;
        markRowCacheDirty('songs');
    }
};

/**
 * Drop every index and mark dirty. Called when the active cache DB
 * changes or the user wipes the cache; the rebuild happens lazily on the
 * next search.
 */
export const resetSearchIndexes = (): void => {
    albumsIndex = undefined;
    artistsIndex = undefined;
    playlistsIndex = undefined;
    songsIndex = undefined;
    albumsDirty = true;
    artistsDirty = true;
    playlistsDirty = true;
    songsDirty = true;
};

const DEFAULT_LIMIT = 50;

/**
 * Run a fuzzy search against the local Dexie-backed indexes for every
 * entity. Returns the top N (default 50) matches per entity. When the
 * cache is unavailable or the query is empty, returns an empty shape so
 * callers can fall through to the network without branching.
 */
export const searchLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<SearchLocalResult> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) {
        return { albums: [], artists: [], playlists: [], songs: [] };
    }

    const start = performance.now();
    const [albumsIdx, artistsIdx, songsIdx, playlistsIdx] = await Promise.all([
        ensureAlbumsIndex(),
        ensureArtistsIndex(),
        ensureSongsIndex(),
        ensurePlaylistsIndex(),
    ]);

    const albums = albumsIdx ? albumsIdx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
    const artists = artistsIdx
        ? artistsIdx.search(trimmed, { limit }).map((r) => r.item.payload)
        : [];
    const songs = songsIdx ? songsIdx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
    const playlists = playlistsIdx
        ? playlistsIdx.search(trimmed, { limit }).map((r) => r.item.payload)
        : [];

    console.info('[cache] search: query', {
        hits: {
            albums: albums.length,
            artists: artists.length,
            playlists: playlists.length,
            songs: songs.length,
        },
        ms: Math.round(performance.now() - start),
        q: trimmed,
    });

    return { albums, artists, playlists, songs };
};

/**
 * Convenience for a single-entity search; reuses the same indexes.
 */
export const searchAlbumsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<Album[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensureAlbumsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
};

export const searchArtistsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<AlbumArtist[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensureArtistsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
};

export const searchSongsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<Song[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensureSongsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
};

export const searchPlaylistsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<Playlist[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensurePlaylistsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
};

// Module-level wiring -----------------------------------------------------
//
// Subscribe once at import time to two cache-store transitions:
//
//   1. `activeServer` changes  → the entire Dexie DB switches under us,
//      every index is invalid. Drop them all.
//   2. `sweep` going from defined → undefined  → a hydration sweep just
//      finished, so the corresponding entity got fresh rows. Mark it
//      dirty so the next search rebuilds.
//
// Both subscriptions only fire on the renderer; in the main process the
// store is never instantiated and these lines are dead code.

if (typeof window !== 'undefined') {
    let prevSweep = useCacheStore.getState().sweep;
    let prevServer = useCacheStore.getState().activeServer;
    useCacheStore.subscribe((state) => {
        if (state.activeServer !== prevServer) {
            prevServer = state.activeServer;
            resetSearchIndexes();
        }
        const next = state.sweep;
        if (prevSweep && !next) {
            // The just-completed sweep targeted `prevSweep.entity`. Map
            // sync entity types to search-index entities and mark dirty,
            // then schedule a background index build so the first user
            // search after a sweep is instant rather than paying a 1-4s
            // build cost. Uses requestIdleCallback when available so the
            // build happens during browser idle time.
            const entity = prevSweep.entity;
            let buildFn: (() => Promise<unknown>) | undefined;
            if (entity === 'albums') {
                markSearchDirty('albums');
                buildFn = ensureAlbumsIndex;
            } else if (entity === 'artists') {
                markSearchDirty('artists');
                buildFn = ensureArtistsIndex;
            } else if (entity === 'songs') {
                markSearchDirty('songs');
                buildFn = ensureSongsIndex;
            } else if (entity === 'playlists') {
                markSearchDirty('playlists');
                buildFn = ensurePlaylistsIndex;
            }
            if (buildFn) {
                const fn = buildFn;
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(() => void fn());
                } else {
                    setTimeout(() => void fn(), 500);
                }
            }
        }
        prevSweep = next;
    });
}
