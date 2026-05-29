// Renderer-process in-memory row cache for the four "list scan" entities
// (albums, songs, album-artists, song-artists). The Dexie cache stores
// every Jellyfin row by primary key; the album/song/artist grids almost
// always need the FULL table because nearly every list query is unfiltered
// or filtered by something Dexie can't index (compilation flags, search
// term, custom backend filter). Calling `db.albums.toArray()` per page in
// the infinite-scroll loader meant pulling the entire ~50k-row table
// through the structured-clone boundary on every scroll tick — the single
// dominant cost on a populated library.
//
// This module keeps one resolved row array per entity in JS, plus a small
// LRU of pre-sorted + pre-filtered result lists keyed by the normalised
// query. Pagination then turns into a slice and a map.
//
// Invalidation
// ------------
//  - markRowCacheDirty('albums')     → next read re-pulls from Dexie
//  - markRowCacheDirty('all')         → drops every layer
//  - resetRowCache()                  → drops every layer (used on server switch)
// Both `markSearchDirty` and a completed sweep already invoke these via
// `search.ts` and the cache store subscription wired below.
//
// Memory profile
// --------------
// Worst-case: 50k songs at ~2KB Payload each = ~100MB. We deliberately keep
// only ONE copy per entity (the read-through cache) plus up to four
// sorted-result lists per entity in the LRU (cap MAX_SORTED_LRU). Each
// sorted list holds references to the same row objects, so the additional
// cost is array headers, not row copies.

import type { LibraryCacheDb } from './db';
import type { CachedAlbum, CachedArtist, CachedSong } from './types';

import { useCacheStore } from './store';

type RowEntity = 'albumArtists' | 'albums' | 'artists' | 'songs';

interface RowEntry {
    promise?: Promise<unknown[]>;
    rows?: unknown[];
}

const rowCache: Record<RowEntity, RowEntry> = {
    albumArtists: {},
    albums: {},
    artists: {},
    songs: {},
};

// Sorted-result LRU. Each entity owns up to MAX_SORTED_LRU entries keyed
// by JSON.stringify of the normalised filter+sort signature. Pagination
// (startIndex + limit) is applied per call so cached entries are reusable
// across page-2, page-3, etc.
const MAX_SORTED_LRU = 6;

interface SortedEntry<T> {
    rows: T[];
    signature: string;
}

const sortedCache: Record<RowEntity, SortedEntry<unknown>[]> = {
    albumArtists: [],
    albums: [],
    artists: [],
    songs: [],
};

/**
 * Drop the cached row array (and every sorted derivative) for the given
 * entity. Callers should invoke this whenever fresh rows land in Dexie
 * (write-through apply, completed sweep, mutation rollback).
 */
export const markRowCacheDirty = (entity: 'all' | RowEntity): void => {
    if (entity === 'all') {
        for (const key of Object.keys(rowCache) as RowEntity[]) {
            rowCache[key] = {};
            sortedCache[key] = [];
        }
        return;
    }
    rowCache[entity] = {};
    sortedCache[entity] = [];
};

/**
 * Discard every layer. Used on server switch.
 */
export const resetRowCache = (): void => {
    markRowCacheDirty('all');
};

/**
 * Load rows for the given entity. The first caller after a dirty mark
 * pulls from Dexie; concurrent callers share the in-flight promise so we
 * never spawn two parallel `toArray()` calls. Subsequent callers (until
 * the next dirty mark) read straight out of the JS heap.
 *
 * The `kindFilter` parameter is exclusive to the artists table where we
 * keep AlbumArtist and Artist rows in the same Dexie table and need to
 * split them in JS.
 */
export const loadEntityRows = async <TRow>(
    entity: RowEntity,
    db: LibraryCacheDb,
    loader: (db: LibraryCacheDb) => Promise<TRow[]>,
): Promise<TRow[]> => {
    const entry = rowCache[entity];
    if (entry.rows) return entry.rows as TRow[];
    if (entry.promise) return entry.promise as Promise<TRow[]>;

    const start = performance.now();
    entry.promise = loader(db).then((rows) => {
        rowCache[entity].rows = rows;
        rowCache[entity].promise = undefined;
        console.info('[cache] local-cache: loaded rows', {
            entity,
            ms: Math.round(performance.now() - start),
            rows: rows.length,
        });
        return rows;
    });
    try {
        return (await entry.promise) as TRow[];
    } catch (err) {
        // Loader threw — clear so the next caller retries from Dexie.
        rowCache[entity].promise = undefined;
        rowCache[entity].rows = undefined;
        throw err;
    }
};

/**
 * Convenience loader for albums (full table). Mirrors the existing
 * `db.albums.toArray()` call so consumers can swap in place.
 */
export const loadAlbumsRows = (db: LibraryCacheDb): Promise<CachedAlbum[]> =>
    loadEntityRows<CachedAlbum>('albums', db, (d) => d.albums.toArray());

/**
 * Convenience loader for songs (full table).
 */
export const loadSongsRows = (db: LibraryCacheDb): Promise<CachedSong[]> =>
    loadEntityRows<CachedSong>('songs', db, (d) => d.songs.toArray());

/**
 * Convenience loaders for the two artist kinds. We keep them in separate
 * row-cache slots because the AlbumArtist and Artist grids re-query each
 * other independently and would otherwise thrash a single shared list.
 */
export const loadAlbumArtistsRows = (db: LibraryCacheDb): Promise<CachedArtist[]> =>
    loadEntityRows<CachedArtist>('albumArtists', db, (d) =>
        d.artists.where('Kind').equals('AlbumArtist').toArray(),
    );

export const loadArtistsRows = (db: LibraryCacheDb): Promise<CachedArtist[]> =>
    loadEntityRows<CachedArtist>('artists', db, (d) =>
        d.artists.where('Kind').equals('Artist').toArray(),
    );

/**
 * Look up a previously-computed sorted+filtered result list by its
 * stringified signature. Returns undefined on a miss. Touching an
 * existing entry bumps it to the MRU position (delete-then-push).
 */
export const lookupSorted = <T>(entity: RowEntity, signature: string): T[] | undefined => {
    const lru = sortedCache[entity];
    for (let i = 0; i < lru.length; i += 1) {
        if (lru[i].signature === signature) {
            const hit = lru[i] as SortedEntry<T>;
            // Bump to MRU.
            lru.splice(i, 1);
            lru.push(hit as SortedEntry<unknown>);
            return hit.rows;
        }
    }
    return undefined;
};

/**
 * Store a sorted+filtered result list against its signature. Drops the
 * oldest entry when the LRU is full.
 */
export const storeSorted = <T>(entity: RowEntity, signature: string, rows: T[]): void => {
    const lru = sortedCache[entity];
    // Remove any stale entry with the same signature (defensive — callers
    // should look up first, but a parallel call may race here).
    for (let i = 0; i < lru.length; i += 1) {
        if (lru[i].signature === signature) {
            lru.splice(i, 1);
            break;
        }
    }
    lru.push({ rows: rows as unknown[], signature });
    while (lru.length > MAX_SORTED_LRU) lru.shift();
};

// Module-level wiring: drop the cache when the active server changes.
if (typeof window !== 'undefined') {
    let prevServer = useCacheStore.getState().activeServer;
    useCacheStore.subscribe((state) => {
        if (state.activeServer !== prevServer) {
            prevServer = state.activeServer;
            resetRowCache();
        }
    });
}

/**
 * Higher-level helper: look up a memo entry, falling back to the
 * `compute` callback when missing and storing the result. The compute
 * function MUST return the full sorted+filtered list (not paginated) —
 * callers slice into it themselves.
 */
export const getOrComputeSorted = async <T>(
    entity: RowEntity,
    signature: string,
    compute: () => Promise<T[] | undefined>,
): Promise<T[] | undefined> => {
    const hit = lookupSorted<T>(entity, signature);
    if (hit !== undefined) return hit;
    const fresh = await compute();
    if (fresh === undefined) return undefined;
    storeSorted<T>(entity, signature, fresh);
    return fresh;
};

/**
 * Build a stable signature string for a list query, excluding
 * pagination fields so every page hits the same memo entry.
 */
export const buildListSignature = (label: string, query: Record<string, unknown>): string => {
    const stripped: Record<string, unknown> = {};
    for (const k of Object.keys(query)) {
        if (k === 'startIndex' || k === 'limit') continue;
        const v = query[k];
        if (v === undefined) continue;
        stripped[k] = v;
    }
    return `${label}:${JSON.stringify(stripped)}`;
};

// Test-only helper: report what's currently cached so the row-cache
// regression test can assert hit/miss without exporting the maps.
export interface LocalCacheDebugSnapshot {
    rows: Record<RowEntity, { count: number | undefined; inFlight: boolean }>;
    sorted: Record<RowEntity, { signatures: string[] }>;
}

export const debugLocalCache = (): LocalCacheDebugSnapshot => ({
    rows: {
        albumArtists: {
            count: rowCache.albumArtists.rows?.length,
            inFlight: rowCache.albumArtists.promise !== undefined,
        },
        albums: {
            count: rowCache.albums.rows?.length,
            inFlight: rowCache.albums.promise !== undefined,
        },
        artists: {
            count: rowCache.artists.rows?.length,
            inFlight: rowCache.artists.promise !== undefined,
        },
        songs: {
            count: rowCache.songs.rows?.length,
            inFlight: rowCache.songs.promise !== undefined,
        },
    },
    sorted: {
        albumArtists: { signatures: sortedCache.albumArtists.map((e) => e.signature) },
        albums: { signatures: sortedCache.albums.map((e) => e.signature) },
        artists: { signatures: sortedCache.artists.map((e) => e.signature) },
        songs: { signatures: sortedCache.songs.map((e) => e.signature) },
    },
});
