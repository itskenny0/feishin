// Persist a downloaded song's metadata into db.songs so the "Available offline"
// view can render it without relying on the library sweep having cached it.
// db.songs carries no audio blobs, so these reads/writes are cheap. Upsert-
// missing only, to avoid churning sweep-written rows.

import type { Song } from '/@/shared/types/domain-types';

import type { LibraryCacheDb } from '../db';

import { getActiveCacheDb } from '../db';
import { toCachedSongRow } from '../row-mappers';

const TAG = '[offline-media]';

// Result of a cacheOfflineSongMeta call. `void`-compatible (existing
// fire-and-forget / awaited-but-ignored call sites keep compiling unchanged)
// but lets a caller that cares (e.g. a future heal-completion gate) detect a
// partial write instead of silently trusting the batch fully landed.
export interface CacheOfflineSongMetaResult {
    added: number;
    failed: number;
}

export const cacheOfflineSongMeta = async (
    songs: Song[],
    db: LibraryCacheDb | undefined = getActiveCacheDb(),
): Promise<CacheOfflineSongMetaResult> => {
    if (!db || songs.length === 0) return { added: 0, failed: 0 };
    // A song payload with no id can't be looked up again later (bulkGet/bulkPut
    // key on it), so writing it would just leave a permanently-unreachable row.
    // Drop it here instead of letting it ride along into the batch.
    const valid = songs.filter((s) => Boolean(s.id));
    if (valid.length !== songs.length) {
        console.warn(`${TAG} cacheOfflineSongMeta dropped songs with no id`, {
            dropped: songs.length - valid.length,
        });
    }
    if (valid.length === 0) return { added: 0, failed: 0 };
    try {
        const ids = valid.map((s) => s.id);
        const existing = await db.songs.bulkGet(ids);
        const missing: Song[] = [];
        for (let i = 0; i < valid.length; i += 1) {
            if (!existing[i]) missing.push(valid[i]);
        }
        if (missing.length === 0) return { added: 0, failed: 0 };
        try {
            await db.songs.bulkPut(missing.map(toCachedSongRow));
            console.info(`${TAG} cached offline song meta`, { added: missing.length });
            return { added: missing.length, failed: 0 };
        } catch (bulkErr) {
            // Dexie's bulkPut runs as a single transaction — one malformed row
            // aborts the WHOLE batch, silently erasing metadata for every other
            // (valid) song enumerated in the same page. Retry row-by-row so a
            // single bad song can't take the rest down with it; this is exactly
            // the kind of gap that leaves the "Available offline" list rendering
            // far fewer rows than are actually downloaded.
            console.warn(`${TAG} bulkPut failed, retrying rows individually`, { err: bulkErr });
            let added = 0;
            let failed = 0;
            for (const song of missing) {
                try {
                    await db.songs.put(toCachedSongRow(song));
                    added += 1;
                } catch (rowErr) {
                    failed += 1;
                    console.warn(`${TAG} cacheOfflineSongMeta row failed`, {
                        err: rowErr,
                        songId: song.id,
                    });
                }
            }
            console.info(`${TAG} cached offline song meta (per-row fallback)`, { added, failed });
            return { added, failed };
        }
    } catch (err) {
        console.warn(`${TAG} cacheOfflineSongMeta failed`, err);
        return { added: 0, failed: valid.length };
    }
};

/**
 * Ground-truth check: how many of the given song ids have no db.songs
 * metadata row. Index-key-only (`.count()` never deserialises a row's
 * Payload), so it's cheap enough to run after every offline-stats refresh
 * even for a multi-thousand-song offline library. A non-zero result means the
 * "Available offline" list will render fewer rows than are actually
 * downloaded — loadOfflineSongs silently skips any blob whose song row is
 * missing — so callers should surface this rather than let the gap go
 * unnoticed. Best-effort against the ACTIVE cache db; returns 0 (no-op) when
 * called against a db a caller injected that isn't the active one (tests).
 */
export const countMissingOfflineSongMeta = async (
    songIds: string[],
    db: LibraryCacheDb | undefined = getActiveCacheDb(),
): Promise<number> => {
    if (!db || songIds.length === 0) return 0;
    try {
        const present = await db.songs.where('Id').anyOf(songIds).count();
        return Math.max(0, songIds.length - present);
    } catch (err) {
        console.warn(`${TAG} countMissingOfflineSongMeta failed`, err);
        return 0;
    }
};
