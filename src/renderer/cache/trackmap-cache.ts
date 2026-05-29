// Dexie-backed cache for lazily-generated trackmap (spectrum) analyses.
//
// The trackmap analysis is expensive (fetch + decode + DSP) and is computed
// ONLY the first time a song is played/visualised — never during the library
// sync sweep. This module persists the generated result so subsequent plays
// of the same song (at the same sensitivity, on the same algorithm version)
// skip the work entirely.
//
// Rows live in the `trackmaps` table (db v10) keyed by the compound
// `[SongId+Sensitivity+Version]`. The cache subsystem's DB is already scoped
// per server+user, so the song id alone is unambiguous within a single DB.
//
// Opt-in: every read/write routes through `getActiveCacheDb()`, which is
// undefined until the user enables the local cache (localCache.enabled) and a
// server+user DB is open. When the cache is disabled this module is inert —
// get() returns undefined and put() is a no-op — and the consumer falls back
// to re-analysing on each play.

import isElectron from 'is-electron';

import type { LibraryCacheDb } from './db';
import type { CachedTrackmap } from './types';

import { getActiveCacheDb } from './db';

// Each Float32Array bins buffer is TRACKMAP_BIN_COUNT (256) * 4 bytes ≈ 1 KB,
// plus Dexie row overhead. A 64 MB cap holds tens of thousands of analyses —
// far more than any realistic listening session — while still bounding growth
// on quota-capped platforms (web / Android WebView). Electron is uncapped.
export const TRACKMAP_CACHE_CAP_BYTES = 64 * 1024 * 1024;

// The shape the worker produces / the canvas consumes. Re-declared here as a
// structural type so this cache module has no import dependency on the
// feature's `types.ts` (the feature delegates to this module, not vice-versa).
export interface TrackmapAnalysis {
    bins: Float32Array;
    computedAt: number;
    durationMs: number;
    version: number;
}

/**
 * Read a cached trackmap analysis for a song at a given sensitivity + version.
 * Returns undefined on a miss (or when the cache is disabled / unavailable).
 * On a hit the row's `LastUsed` is bumped (fire-and-forget) so the eviction
 * pass treats recently-played songs as hot.
 */
export const getCachedTrackmap = async (
    songId: string,
    sensitivity: number,
    version: number,
): Promise<TrackmapAnalysis | undefined> => {
    const db = getActiveCacheDb();
    if (!db) return undefined;
    try {
        const row = await db.trackmaps.get([songId, sensitivity, version]);
        if (!row) return undefined;
        // Defensive: a row written by an older shape might not round-trip as a
        // Float32Array (e.g. if the structured clone landed as a plain array).
        // Treat anything that isn't a Float32Array as a miss.
        if (!(row.Bins instanceof Float32Array)) return undefined;
        // Bump LRU timestamp without blocking the read path.
        void db.trackmaps
            .update([songId, sensitivity, version], { LastUsed: Date.now() })
            .catch(() => undefined);
        return {
            bins: row.Bins,
            computedAt: row.ComputedAt,
            durationMs: row.DurationMs,
            version: row.Version,
        };
    } catch (err) {
        console.warn('[cache] getCachedTrackmap failed', { err, songId });
        return undefined;
    }
};

/**
 * Persist a generated trackmap analysis. No-op when the cache is disabled /
 * unavailable. Triggers an opportunistic eviction pass after the write so the
 * cap is enforced lazily (the pass early-returns cheaply when under cap).
 */
export const putCachedTrackmap = async (
    songId: string,
    sensitivity: number,
    data: TrackmapAnalysis,
): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    try {
        const now = Date.now();
        const row: CachedTrackmap = {
            __cachedAt: now,
            Bins: data.bins,
            ByteSize: data.bins.byteLength,
            ComputedAt: data.computedAt,
            DurationMs: data.durationMs,
            LastUsed: now,
            Sensitivity: sensitivity,
            SongId: songId,
            Version: data.version,
        };
        await db.trackmaps.put(row);
        console.info('[cache] trackmap cached', {
            bytes: row.ByteSize,
            sensitivity,
            songId,
            version: data.version,
        });
        // Enforce the cap lazily after a write. Never await — the analysis
        // result is already returned to the caller; eviction is housekeeping.
        void evictTrackmaps().catch((err) =>
            console.warn('[cache] trackmap eviction after put failed', err),
        );
    } catch (err) {
        // Quota exceeded, DB closing mid-write, etc. — silent, the consumer
        // simply re-analyses next time.
        console.warn('[cache] putCachedTrackmap failed', { err, songId });
    }
};

/**
 * Sum the `ByteSize` index of the trackmaps table without materialising any
 * Bins buffers — same Blob-free projection trick the thumbnails eviction uses.
 */
export const sumTrackmapBytes = async (db: LibraryCacheDb): Promise<number> => {
    try {
        const keys = await db.trackmaps.orderBy('ByteSize').keys();
        let total = 0;
        for (const k of keys) {
            if (typeof k === 'number') total += k;
        }
        return total;
    } catch (err) {
        console.warn('[cache] sumTrackmapBytes failed', err);
        return 0;
    }
};

// Coalesce concurrent eviction passes. Every successful put() fires a
// fire-and-forget eviction; without this guard two passes could read the same
// `used` snapshot, each build a delete set against it, and over-evict. While a
// pass is in flight, later callers await the same promise instead of starting
// a second, racing pass.
let evictionInFlight: Promise<void> | undefined;

/**
 * LRU eviction pass for the trackmaps table. Cheap when under cap — the first
 * checks short-circuit. Electron is uncapped so the pass is a no-op there.
 * Drops least-recently-used analyses first until total bytes fall back under
 * TRACKMAP_CACHE_CAP_BYTES. Concurrent calls coalesce onto one in-flight pass.
 */
export const evictTrackmaps = async (): Promise<void> => {
    if (evictionInFlight) return evictionInFlight;
    evictionInFlight = runEvictTrackmaps().finally(() => {
        evictionInFlight = undefined;
    });
    return evictionInFlight;
};

const runEvictTrackmaps = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    // Electron desktop has effectively unlimited disk and is intentionally
    // uncapped (mirrors the thumbnails eviction policy in eviction.ts).
    if (isElectron()) return;

    const cap = TRACKMAP_CACHE_CAP_BYTES;
    const used = await sumTrackmapBytes(db);
    if (used <= cap) return;

    console.info('[cache] trackmap eviction: starting pass', { cap, used });

    let dropped = 0;
    let droppedCount = 0;
    const toDelete: [string, number, number][] = [];
    try {
        await db.trackmaps
            .orderBy('LastUsed')
            .until(() => used - dropped <= cap)
            .each((row) => {
                // Drop the Bins ref ASAP so the GC can reclaim it before the
                // cursor advances.
                const bytes = row.ByteSize;
                (row as { Bins?: Float32Array }).Bins = undefined;
                toDelete.push([row.SongId, row.Sensitivity, row.Version]);
                dropped += bytes;
                droppedCount += 1;
            });
        if (toDelete.length > 0) {
            await db.trackmaps.bulkDelete(toDelete);
        }
    } catch (err) {
        console.warn('[cache] trackmap eviction: query failed', err);
    }

    console.info('[cache] trackmap eviction: dropped', {
        count: droppedCount,
        freedBytes: dropped,
    });
};

/**
 * Wipe the trackmaps table. Used by the "Clear cache → everything" path.
 */
export const clearTrackmaps = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    await db.trackmaps.clear();
    console.info('[cache] cleared trackmaps');
};
