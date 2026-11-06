// Local-first global search backed by fuse.js indexes built lazily from
// the Dexie tables. The indexes are constructed on the first search call
// after init (and rebuilt whenever the underlying table is marked dirty),
// reused for the rest of the session.
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
// The next ensure() call rebuilds from the current Dexie contents.
// Rebuilds happen at most once per stale-marker, not per-row; the cost of
// rebuilding on every write would dominate the wall-clock budget.

import type { Album, AlbumArtist, Song } from '/@/shared/types/domain-types';

import Fuse, { type IFuseOptions } from 'fuse.js';

import type { LibraryCacheDb } from './db';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import { markRowsChanged } from './local-cache';
import { useCacheStore } from './store';

type IndexedEntity = 'albums' | 'artists' | 'songs';

// Slim search-index entry. We hold a reference to the original Payload so
// result mapping is a single property read, but the Fuse index itself only
// walks the `name` / `artist` fields, which keeps the indexing cost
// proportional to the indexed bytes, not to the full row payload.
interface SearchEntry<P> {
    artist?: string;
    name: string;
    payload: P;
}

const fuseOptions = <P>(
    keys: IFuseOptions<SearchEntry<P>>['keys'],
): IFuseOptions<SearchEntry<P>> => ({
    ignoreLocation: true,
    keys,
    threshold: 0.3,
    useExtendedSearch: false,
});

// Load an entire (possibly very large) table/collection in chunks, yielding to
// the event loop between chunks. A 14k-artist library used to build its Fuse
// index from a single `toArray()` that structured-cloned every row's full
// Payload in one synchronous burst — a 1-7s main-thread FREEZE on the first
// search (the cost is the deserialization, not Fuse). Chunking the read and
// yielding between chunks keeps input + paint responsive; the background
// prewarm (see schedulePrewarm) then moves the work off the search path
// entirely. Returns null if the active cache DB switched mid-load (checked
// after every chunk, including the last) - the rows would belong to the
// previous server, so the caller must discard and let the next caller rebuild
// against the new DB.
const INDEX_BUILD_CHUNK = 1000;
const loadAllChunked = async <T>(
    db: LibraryCacheDb,
    queryChunk: (offset: number, limit: number) => Promise<T[]>,
): Promise<null | T[]> => {
    const rows: T[] = [];
    for (let offset = 0; ; offset += INDEX_BUILD_CHUNK) {
        const batch = await queryChunk(offset, INDEX_BUILD_CHUNK);
        if (db !== getActiveCacheDb()) return null;
        for (let i = 0; i < batch.length; i += 1) rows.push(batch[i]);
        if (batch.length < INDEX_BUILD_CHUNK) break;
        // Yield so a queued search keystroke / paint can interleave between
        // chunk deserializations instead of waiting for the whole table.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
    return rows;
};

// One lazily-built Fuse index per entity, rebuilt on the next access after a
// dirty mark. Concurrent callers (a search + the background prewarm) share a
// single in-flight build, and a build that a dirty mark / reset overtook is
// still returned to its callers but not installed, so the next access
// rebuilds from the fresh rows.
const createIndex = <P>(
    entity: IndexedEntity,
    queryChunk: (db: LibraryCacheDb, offset: number, limit: number) => Promise<{ Payload: P }[]>,
    toEntry: (payload: P) => SearchEntry<P>,
    options: IFuseOptions<SearchEntry<P>>,
) => {
    let index: Fuse<SearchEntry<P>> | undefined;
    let building: Promise<Fuse<SearchEntry<P>> | undefined> | undefined;
    let dirty = true;
    let generation = 0;

    const build = async (): Promise<Fuse<SearchEntry<P>> | undefined> => {
        const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
        if (!db) return undefined;
        const gen = generation;
        const start = performance.now();
        const rows = await loadAllChunked(db, (offset, limit) => queryChunk(db, offset, limit));
        if (!rows) {
            console.info(`[cache] search: ${entity} index discarded, active db changed mid-build`);
            return undefined;
        }
        const built = new Fuse(
            rows.map((r) => toEntry(r.Payload)),
            options,
        );
        if (gen === generation) {
            index = built;
            dirty = false;
        }
        console.info('[cache] search: index built', {
            entity,
            ms: Math.round(performance.now() - start),
            rows: rows.length,
        });
        return built;
    };

    const ensure = (): Promise<Fuse<SearchEntry<P>> | undefined> => {
        if (index && !dirty) return Promise.resolve(index);
        building ??= build().finally(() => {
            building = undefined;
        });
        return building;
    };

    const search = async (query: string, limit: number): Promise<P[]> => {
        const trimmed = (query ?? '').trim();
        if (!trimmed) return [];
        const idx = await ensure();
        return idx ? idx.search(trimmed, { limit }).map((r) => r.item.payload) : [];
    };

    const markDirty = (): void => {
        dirty = true;
        generation += 1;
    };

    const reset = (): void => {
        markDirty();
        index = undefined;
    };

    return { ensure, markDirty, reset, search };
};

const indexes = {
    albums: createIndex<Album>(
        'albums',
        (db, offset, limit) => db.albums.offset(offset).limit(limit).toArray(),
        (p) => ({ artist: p.albumArtists?.[0]?.name ?? '', name: p.name ?? '', payload: p }),
        fuseOptions([
            { name: 'name', weight: 0.7 },
            { name: 'artist', weight: 0.3 },
        ]),
    ),
    artists: createIndex<AlbumArtist>(
        'artists',
        (db, offset, limit) =>
            db.artists.where('Kind').equals('AlbumArtist').offset(offset).limit(limit).toArray(),
        (p) => ({ name: p.name ?? '', payload: p }),
        fuseOptions([{ name: 'name', weight: 1 }]),
    ),
    songs: createIndex<Song>(
        'songs',
        (db, offset, limit) => db.songs.offset(offset).limit(limit).toArray(),
        (p) => ({ artist: p.albumArtists?.[0]?.name ?? '', name: p.name ?? '', payload: p }),
        fuseOptions([
            { name: 'name', weight: 0.6 },
            { name: 'artist', weight: 0.4 },
        ]),
    ),
};
const INDEXED_ENTITIES = Object.keys(indexes) as IndexedEntity[];

// Background prewarm: after rows are marked dirty (a sync/apply/sweep landed
// fresh data) rebuild the indexes OFF the search path so the user's first
// search is instant rather than paying the (now-chunked, but still non-zero)
// build cost inline. Debounced so a burst of per-entity markSearchDirty calls
// during a sweep coalesces into ONE rebuild, and run on idle so it never
// competes with foreground work. ensure() is a no-op when its index is
// already clean, so a redundant schedule is cheap.
let prewarmTimer: ReturnType<typeof setTimeout> | undefined;
const runPrewarm = (): void => {
    for (const entity of INDEXED_ENTITIES) void indexes[entity].ensure();
};
const schedulePrewarm = (): void => {
    if (!isCacheAvailableSync()) return;
    if (prewarmTimer) clearTimeout(prewarmTimer);
    prewarmTimer = setTimeout(() => {
        prewarmTimer = undefined;
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(runPrewarm, { timeout: 5000 });
        } else {
            runPrewarm();
        }
    }, 3000);
};

/**
 * Mark an entity's local search index as stale. The next search that
 * touches that entity will rebuild it from the current Dexie contents.
 * Coarse-grained on purpose: write-through paths call this once at the end
 * of an `apply` rather than per-row, and a sweep completion marks every
 * affected entity at once. Playlists have no search index (global search
 * never queries them locally), so marking them is a no-op.
 *
 * IMPORTANT (perf fix #1): this is now FUSE-ONLY. It deliberately does NOT
 * touch the grid row cache / sorted LRU (`local-cache.ts`). A background
 * revalidate that re-applies the same rows used to nuke those memos here,
 * forcing the next scroll to re-`toArray()` + re-sort the whole table. The
 * fuse index can rebuild lazily on the next search at far lower cost, and the
 * grid row cache is now invalidated separately — and only when rows actually
 * changed — via `markRowsChangedFromPage` (or `markRowCacheDirty` for
 * deletes / wipes). Callers that mutate rows must invalidate the row cache
 * explicitly; `markSearchDirty` alone no longer refreshes the grid.
 */
export const markSearchDirty = (entity: 'all' | 'playlists' | IndexedEntity): void => {
    if (entity === 'playlists') return;
    for (const e of entity === 'all' ? INDEXED_ENTITIES : [entity]) indexes[e].markDirty();
    schedulePrewarm();
};

/**
 * Drop every index and mark dirty. Called when the active cache DB
 * changes or the user wipes the cache; the rebuild happens lazily on the
 * next search.
 */
export const resetSearchIndexes = (): void => {
    if (prewarmTimer) {
        clearTimeout(prewarmTimer);
        prewarmTimer = undefined;
    }
    for (const entity of INDEXED_ENTITIES) indexes[entity].reset();
};

const DEFAULT_LIMIT = 50;

/**
 * Fuzzy-search one entity's local Dexie-backed index. Returns the top N
 * (default 50) matches, or an empty list when the query is blank or the
 * cache is unavailable so callers can fall through to the network.
 */
export const searchAlbumsLocal = (query: string, limit = DEFAULT_LIMIT): Promise<Album[]> =>
    indexes.albums.search(query, limit);

export const searchArtistsLocal = (query: string, limit = DEFAULT_LIMIT): Promise<AlbumArtist[]> =>
    indexes.artists.search(query, limit);

export const searchSongsLocal = (query: string, limit = DEFAULT_LIMIT): Promise<Song[]> =>
    indexes.songs.search(query, limit);

// Module-level wiring -----------------------------------------------------
//
// Subscribe once at import time to two cache-store transitions:
//
//   1. `activeServer` changes  → the entire Dexie DB switches under us,
//      every index is invalid. Drop them all.
//   2. `sweep` going from defined → undefined  → a hydration sweep just
//      finished, so the corresponding entity got fresh rows. Mark it dirty
//      and schedule an idle rebuild so the first user search after a sweep
//      is instant rather than paying a 1-4s build cost. The sweep also left
//      the grid row cache + sorted LRU genuinely stale: drop them via
//      markRowsChanged (markSearchDirty alone is fuse-only).
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
        const entity = prevSweep?.entity;
        if (!next && (entity === 'albums' || entity === 'artists' || entity === 'songs')) {
            markSearchDirty(entity);
            markRowsChanged(entity);
            const { ensure } = indexes[entity];
            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => void ensure());
            } else {
                setTimeout(() => void ensure(), 500);
            }
        }
        prevSweep = next;
    });
}
