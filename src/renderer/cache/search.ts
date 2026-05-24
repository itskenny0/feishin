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

import type { CachedAlbum, CachedArtist, CachedPlaylist, CachedSong } from './types';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import { useCacheStore } from './store';

export interface SearchLocalResult {
    albums: Album[];
    artists: AlbumArtist[];
    playlists: Playlist[];
    songs: Song[];
}

type Entity = 'albums' | 'artists' | 'playlists' | 'songs';

// Per-entity index state. Each index is paired with a "dirty" flag so the
// next access rebuilds when the underlying rows have changed.
let albumsIndex: Fuse<CachedAlbum> | undefined;
let albumsDirty = true;
let artistsIndex: Fuse<CachedArtist> | undefined;
let artistsDirty = true;
let playlistsIndex: Fuse<CachedPlaylist> | undefined;
let playlistsDirty = true;
let songsIndex: Fuse<CachedSong> | undefined;
let songsDirty = true;

const albumFuseOptions: IFuseOptions<CachedAlbum> = {
    ignoreLocation: true,
    keys: [
        { name: 'Payload.name', weight: 0.7 },
        { name: 'Payload.albumArtists.0.name', weight: 0.3 },
    ],
    threshold: 0.3,
    useExtendedSearch: false,
};

const artistFuseOptions: IFuseOptions<CachedArtist> = {
    ignoreLocation: true,
    keys: [{ name: 'Payload.name', weight: 1 }],
    threshold: 0.3,
    useExtendedSearch: false,
};

const playlistFuseOptions: IFuseOptions<CachedPlaylist> = {
    ignoreLocation: true,
    keys: [{ name: 'Payload.name', weight: 1 }],
    threshold: 0.3,
    useExtendedSearch: false,
};

const songFuseOptions: IFuseOptions<CachedSong> = {
    ignoreLocation: true,
    keys: [
        { name: 'Payload.name', weight: 0.6 },
        { name: 'Payload.albumArtists.0.name', weight: 0.4 },
    ],
    threshold: 0.3,
    useExtendedSearch: false,
};

const ensureAlbumsIndex = async (): Promise<Fuse<CachedAlbum> | undefined> => {
    if (albumsIndex && !albumsDirty) return albumsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.albums.toArray();
    albumsIndex = new Fuse(rows, albumFuseOptions);
    albumsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'albums',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return albumsIndex;
};

const ensureArtistsIndex = async (): Promise<Fuse<CachedArtist> | undefined> => {
    if (artistsIndex && !artistsDirty) return artistsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.artists.where('Kind').equals('AlbumArtist').toArray();
    artistsIndex = new Fuse(rows, artistFuseOptions);
    artistsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'artists',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return artistsIndex;
};

const ensurePlaylistsIndex = async (): Promise<Fuse<CachedPlaylist> | undefined> => {
    if (playlistsIndex && !playlistsDirty) return playlistsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.playlists.toArray();
    playlistsIndex = new Fuse(rows, playlistFuseOptions);
    playlistsDirty = false;
    console.info('[cache] search: index built', {
        entity: 'playlists',
        ms: Math.round(performance.now() - start),
        rows: rows.length,
    });
    return playlistsIndex;
};

const ensureSongsIndex = async (): Promise<Fuse<CachedSong> | undefined> => {
    if (songsIndex && !songsDirty) return songsIndex;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return undefined;
    const start = performance.now();
    const rows = await db.songs.toArray();
    songsIndex = new Fuse(rows, songFuseOptions);
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
        return;
    }
    if (entity === 'albums') albumsDirty = true;
    if (entity === 'artists') artistsDirty = true;
    if (entity === 'playlists') playlistsDirty = true;
    if (entity === 'songs') songsDirty = true;
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

    const albums = albumsIdx ? albumsIdx.search(trimmed, { limit }).map((r) => r.item.Payload) : [];
    const artists = artistsIdx
        ? artistsIdx.search(trimmed, { limit }).map((r) => r.item.Payload)
        : [];
    const songs = songsIdx ? songsIdx.search(trimmed, { limit }).map((r) => r.item.Payload) : [];
    const playlists = playlistsIdx
        ? playlistsIdx.search(trimmed, { limit }).map((r) => r.item.Payload)
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
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.Payload) : [];
};

export const searchArtistsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<AlbumArtist[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensureArtistsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.Payload) : [];
};

export const searchSongsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<Song[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensureSongsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.Payload) : [];
};

export const searchPlaylistsLocal = async (
    query: string,
    limit: number = DEFAULT_LIMIT,
): Promise<Playlist[]> => {
    const trimmed = (query ?? '').trim();
    if (!trimmed) return [];
    const idx = await ensurePlaylistsIndex();
    return idx ? idx.search(trimmed, { limit }).map((r) => r.item.Payload) : [];
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
