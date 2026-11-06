// Local-first global search backed by fuse.js indexes built lazily from
// the Dexie tables. The indexes are constructed on the first search call
// after init (and rebuilt whenever the underlying table is marked dirty),
// reused for the rest of the session.
//
// Index strategy
// --------------
// Each entity owns a single Fuse index over slim `{ id, name, artist }`
// entries (search-index.ts): artists are filtered to Kind === 'AlbumArtist',
// since the global search UI lists album artists, and songs/albums also
// match the leading album-artist name so a search for "beatles abbey" finds
// "Abbey Road" by the Beatles. A search maps its hit ids back to payloads
// with one `bulkGet`.
//
// The indexes live in a Web Worker (search-index.worker.ts) that reads the
// DB itself, so neither the full-table read, the Fuse build nor the
// per-keystroke Fuse scan runs on the renderer main thread. Without Worker
// support (or if the worker fails) the same code runs on the main thread.
//
// Dirty marking
// -------------
// Whenever a write-through path (hook `apply`) lands fresh rows in Dexie
// or a hydration sweep completes, callers invoke `markSearchDirty(entity)`.
// The next ensure() call rebuilds from the current Dexie contents.
// Rebuilds happen at most once per stale-marker, not per-row; the cost of
// rebuilding on every write would dominate the wall-clock budget.

import type { Album, AlbumArtist, Song } from '/@/shared/types/domain-types';
import type Fuse from 'fuse.js';

import type { LibraryCacheDb } from './db';
import type { SearchWorkerRequest, SearchWorkerResponse } from './search-index.worker';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import { markRowsChanged } from './local-cache';
import {
    type ChunkTable,
    createSearchFuse,
    readSearchEntries,
    type SearchEntity,
    type SearchEntry,
} from './search-index';
import { useCacheStore } from './store';

type IndexedEntity = SearchEntity;

// Worker client ------------------------------------------------------------

type WorkerCall =
    | Omit<Extract<SearchWorkerRequest, { type: 'build' }>, 'id'>
    | Omit<Extract<SearchWorkerRequest, { type: 'search' }>, 'id'>;

// undefined: not spawned yet; null: unavailable, index on the main thread.
let worker: null | undefined | Worker;
let nextRequestId = 1;
const pendingCalls = new Map<
    number,
    { reject: (err: Error) => void; resolve: (res: SearchWorkerResponse) => void }
>();

const disableWorker = (reason: string): void => {
    console.warn('[cache] search: worker unavailable, indexing on the main thread', { reason });
    worker?.terminate();
    worker = null;
    for (const call of pendingCalls.values()) call.reject(new Error(reason));
    pendingCalls.clear();
    // Indexes that lived in the worker are gone; rebuild on next use.
    for (const entity of INDEXED_ENTITIES) indexes[entity].reset();
};

const getWorker = (): null | Worker => {
    if (worker !== undefined) return worker;
    if (typeof Worker === 'undefined') {
        worker = null;
        return null;
    }
    try {
        worker = new Worker(new URL('./search-index.worker.ts', import.meta.url), {
            type: 'module',
        });
    } catch (err) {
        disableWorker((err as Error)?.message ?? String(err));
        return null;
    }
    worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
        const msg = event.data;
        const call = pendingCalls.get(msg.id);
        if (!call) return;
        pendingCalls.delete(msg.id);
        if (msg.ok) call.resolve(msg);
        else call.reject(new Error(msg.error));
    };
    worker.onerror = (event) => disableWorker(event.message || 'search worker error');
    return worker;
};

const callWorker = (w: Worker, request: WorkerCall): Promise<SearchWorkerResponse> =>
    new Promise((resolve, reject) => {
        const id = nextRequestId;
        nextRequestId += 1;
        pendingCalls.set(id, { reject, resolve });
        w.postMessage({ ...request, id });
    });

// A Fuse scan over 29k songs takes 0.3-1.3 s on a phone-class CPU, and the
// search UI issues one per debounced keystroke. Per entity, at most one
// search waits behind the running one; a newer keystroke replaces it (the
// replaced caller gets no hits), so a fast typist never builds a backlog.
interface QueuedSearch {
    limit: number;
    query: string;
    resolve: (ids: string[]) => void;
}
const runningSearches = new Set<IndexedEntity>();
const queuedSearches = new Map<IndexedEntity, QueuedSearch>();

const runWorkerSearch = (w: Worker, entity: IndexedEntity, job: QueuedSearch): void => {
    runningSearches.add(entity);
    callWorker(w, { entity, limit: job.limit, query: job.query, type: 'search' })
        .then(
            (res) => job.resolve('ids' in res ? res.ids : []),
            () => job.resolve([]),
        )
        .finally(() => {
            runningSearches.delete(entity);
            const next = queuedSearches.get(entity);
            if (!next) return;
            queuedSearches.delete(entity);
            const current = getWorker();
            if (current) runWorkerSearch(current, entity, next);
            else next.resolve([]);
        });
};

const searchInWorker = (entity: IndexedEntity, query: string, limit: number): Promise<string[]> =>
    new Promise((resolve) => {
        const w = getWorker();
        if (!w) {
            resolve([]);
            return;
        }
        const job = { limit, query, resolve };
        if (!runningSearches.has(entity)) {
            runWorkerSearch(w, entity, job);
            return;
        }
        queuedSearches.get(entity)?.resolve([]);
        queuedSearches.set(entity, job);
    });

// Indexes -------------------------------------------------------------------

// null: discarded because the active cache DB switched mid-build (the rows
// belong to the previous server); the next caller rebuilds against the new DB.
type Built = null | { handle: IndexHandle; rows: number };

// `fuse` is set when the index was built on the main thread; without it the
// index lives in the worker.
interface IndexHandle {
    db: LibraryCacheDb;
    fuse?: Fuse<SearchEntry>;
}

// One lazily-built index per entity, rebuilt on the next access after a
// dirty mark. Concurrent callers (a search + the background prewarm) share a
// single in-flight build, and a build that a dirty mark / reset overtook is
// still returned to its callers but not installed, so the next access
// rebuilds from the fresh rows.
const createIndex = <P>(entity: IndexedEntity) => {
    let index: IndexHandle | undefined;
    let building: Promise<IndexHandle | undefined> | undefined;
    let dirty = true;
    let generation = 0;

    const buildInWorker = async (w: Worker, db: LibraryCacheDb): Promise<'unavailable' | Built> => {
        try {
            const res = await callWorker(w, { dbName: db.name, entity, type: 'build' });
            const rows = 'rows' in res ? res.rows : null;
            return rows === null || db !== getActiveCacheDb() ? null : { handle: { db }, rows };
        } catch (err) {
            console.warn(`[cache] search: worker build failed (${entity}), using main thread`, {
                error: (err as Error)?.message,
            });
            return 'unavailable';
        }
    };

    const buildOnMainThread = async (db: LibraryCacheDb): Promise<Built> => {
        const entries = await readSearchEntries(
            db[entity] as unknown as ChunkTable,
            entity,
            () => db === getActiveCacheDb(),
            true,
        );
        return entries
            ? { handle: { db, fuse: createSearchFuse(entity, entries) }, rows: entries.length }
            : null;
    };

    const build = async (): Promise<IndexHandle | undefined> => {
        const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
        if (!db) return undefined;
        const gen = generation;
        const start = performance.now();
        const w = getWorker();
        let built: 'unavailable' | Built = w ? await buildInWorker(w, db) : 'unavailable';
        const inWorker = built !== 'unavailable';
        if (built === 'unavailable') built = await buildOnMainThread(db);
        if (!built) {
            console.info(`[cache] search: ${entity} index discarded, active db changed mid-build`);
            return undefined;
        }
        if (gen === generation) {
            index = built.handle;
            dirty = false;
        }
        console.info('[cache] search: index built', {
            entity,
            inWorker,
            ms: Math.round(performance.now() - start),
            rows: built.rows,
        });
        return built.handle;
    };

    const ensure = (): Promise<IndexHandle | undefined> => {
        if (index && !dirty) return Promise.resolve(index);
        building ??= build().finally(() => {
            building = undefined;
        });
        return building;
    };

    const search = async (query: string, limit: number): Promise<P[]> => {
        const trimmed = (query ?? '').trim();
        if (!trimmed) return [];
        const handle = await ensure();
        if (!handle) return [];
        const ids = handle.fuse
            ? handle.fuse.search(trimmed, { limit }).map((r) => r.item.id)
            : await searchInWorker(entity, trimmed, limit);
        if (ids.length === 0) return [];
        const table = handle.db[entity] as unknown as {
            bulkGet: (keys: string[]) => Promise<(undefined | { Payload: P })[]>;
        };
        const rows = await table.bulkGet(ids);
        // A row deleted since the build simply drops out of the hits.
        return rows.flatMap((row) => (row ? [row.Payload] : []));
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
    albums: createIndex<Album>('albums'),
    artists: createIndex<AlbumArtist>('artists'),
    songs: createIndex<Song>('songs'),
};
const INDEXED_ENTITIES = Object.keys(indexes) as IndexedEntity[];

// Background prewarm: after rows are marked dirty (a sync/apply/sweep landed
// fresh data) rebuild the indexes OFF the search path so the user's first
// search is instant rather than paying the build cost inline. Debounced so a
// burst of per-entity markSearchDirty calls during a sweep coalesces into ONE
// rebuild, and run on idle so it never competes with foreground work.
// ensure() is a no-op when its index is already clean, so a redundant
// schedule is cheap.
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
    worker?.postMessage({ type: 'reset' } satisfies SearchWorkerRequest);
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
//      every index is invalid. Drop them all. With the worker available, warm the
//      new DB's indexes in the background (no main-thread cost) so the first
//      search of a session doesn't wait on a cold build.
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
            if (state.activeServer && getWorker()) schedulePrewarm();
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
