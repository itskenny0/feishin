// Local-cache quota probing and LRU eviction.
//
// Web (PWA) and Android (Capacitor WebView) are subject to per-origin
// storage quotas, so we maintain a soft cap and evict thumbnails in
// least-recently-used order whenever the cap is exceeded. Electron
// desktop has effectively unlimited disk and is intentionally uncapped.
//
// Eviction is triggered opportunistically after every thumbnail write
// via the `feishin:thumbnail-written` window event. The pass is cheap
// when usage is under the cap (early-return), so wiring it to every
// write is a reasonable trade.

import isElectron from 'is-electron';

import type { LibraryCacheDb } from './db';

import { getActiveCacheDb } from './db';
import { useCacheStore } from './store';

import { useSettingsStore } from '/@/renderer/store';

const TWO_GB = 2 * 1024 * 1024 * 1024;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LARGE_THUMBNAIL_ROW_WARN = 50_000;

let cachedIsQuotaCapped: boolean | undefined;

/**
 * Whether the current platform enforces a per-origin storage quota
 * (i.e. anything that isn't Electron). The answer is platform-static
 * for the lifetime of the process, so we memoise it.
 */
export const isQuotaCapped = (): boolean => {
    if (cachedIsQuotaCapped === undefined) {
        cachedIsQuotaCapped = !isElectron();
    }
    return cachedIsQuotaCapped;
};

/**
 * Best-effort estimate of total origin storage bytes used as reported
 * by the StorageManager API. Returns undefined when the API is
 * unavailable or throws.
 */
/**
 * Sum the `ByteSize` index on the thumbnails table without ever
 * materialising blob rows. CRITICAL: `db.thumbnails.toArray()` pulls
 * every Blob into memory — on a hydrated library that's tens to
 * hundreds of megabytes per call, and `estimateBytes()` /
 * `cachedBytes()` were being invoked on every successful thumbnail
 * write via the `feishin:thumbnail-written` cascade. The resulting
 * read traffic serialised the IndexedDB worker thread against
 * concurrent puts, dropping the sweep's effective throughput to a
 * tiny fraction of network capacity.
 *
 * Reading the `ByteSize` index via `.keys()` skips the row store
 * entirely — IndexedDB hands back just the indexed integers.
 */
const sumThumbnailBytes = async (db: LibraryCacheDb): Promise<number> => {
    const keys = await db.thumbnails.orderBy('ByteSize').keys();
    let total = 0;
    for (const k of keys) {
        if (typeof k === 'number') total += k;
    }
    return total;
};

export const estimateBytes = async (): Promise<number | undefined> => {
    // Prefer summing actual Dexie row sizes — `navigator.storage.estimate()`
    // returns the WHOLE origin's quota usage (cookies, localStorage, every
    // IndexedDB database the origin touches), and on Chromium-based engines
    // it lags behind by tens of seconds while the user is actively
    // writing. Summing `db.thumbnails.ByteSize` + a coarse per-row
    // estimate for the entity tables is more responsive AND more
    // accurate to what the user means by "cache size".
    const db = getActiveCacheDb();
    if (db) {
        try {
            const [
                thumbnailBytes,
                albums,
                artists,
                songs,
                playlists,
                favorites,
                genres,
                lyrics,
                playlistSongs,
            ] = await Promise.all([
                sumThumbnailBytes(db),
                db.albums.count(),
                db.artists.count(),
                db.songs.count(),
                db.playlists.count(),
                db.favorites.count(),
                db.genres.count(),
                db.lyrics.count(),
                db.playlistSongs.count(),
            ]);
            // Rough per-row sizes from observed payload widths in dev. We
            // could JSON.stringify every Payload for an exact number but
            // counting 18k rows is too slow for a UI refresh; the
            // estimates are conservative averages.
            const albumBytes = albums * 1024;
            const artistBytes = artists * 768;
            const songBytes = songs * 1536;
            const playlistBytes = playlists * 512;
            const favoriteBytes = favorites * 96;
            const genreBytes = genres * 192;
            const lyricsBytes = lyrics * 4096;
            const playlistSongBytes = playlistSongs * 256;
            return (
                thumbnailBytes +
                albumBytes +
                artistBytes +
                songBytes +
                playlistBytes +
                favoriteBytes +
                genreBytes +
                lyricsBytes +
                playlistSongBytes
            );
        } catch (err) {
            console.warn('[cache] estimateBytes Dexie sum failed', err);
        }
    }
    // Fallback to the navigator API when no DB is active or the sum
    // failed.
    try {
        if (typeof navigator === 'undefined') return undefined;
        const est = await navigator.storage?.estimate?.();
        return est?.usage;
    } catch {
        return undefined;
    }
};

/**
 * Total bytes occupied by thumbnail blobs in the active cache DB.
 * Metadata tables (albums, artists, songs, etc.) are not counted —
 * the dashboard combines this number with `estimateBytes()` for the
 * full picture. Returns 0 when no cache DB is active.
 */
export const cachedBytes = async (): Promise<number> => {
    const db = getActiveCacheDb();
    if (!db) return 0;
    try {
        // See sumThumbnailBytes() for why we read the ByteSize index
        // keys instead of materialising every Blob via toArray().
        const total = await sumThumbnailBytes(db);
        const rowCount = await db.thumbnails.count();
        if (rowCount >= LARGE_THUMBNAIL_ROW_WARN) {
            console.warn('[cache] thumbnail row count is very large', {
                rows: rowCount,
            });
        }
        return total;
    } catch (err) {
        console.warn('[cache] cachedBytes failed', { err });
        return 0;
    }
};

/**
 * Platform-derived default cap. Electron is uncapped. Other platforms
 * default to min(60% of the browser-reported quota, 2 GB). Falls back
 * to 2 GB if the StorageManager API is unavailable or throws.
 */
export const defaultCapBytes = async (): Promise<number> => {
    if (!isQuotaCapped()) return Number.POSITIVE_INFINITY;
    try {
        if (typeof navigator === 'undefined') return TWO_GB;
        const est = await navigator.storage?.estimate?.();
        const quota = est?.quota;
        if (typeof quota === 'number' && quota > 0) {
            return Math.min(Math.floor(quota * 0.6), TWO_GB);
        }
        return TWO_GB;
    } catch {
        return TWO_GB;
    }
};

/**
 * Effective cap — the user-configurable override (set from the Settings ->
 * Library sync dashboard) wins when present and positive; otherwise we
 * fall back to the platform default. Electron remains uncapped because
 * `defaultCapBytes()` returns +Infinity there.
 */
export const getCurrentCapBytes = async (): Promise<number> => {
    const configured = useSettingsStore.getState().localCache?.capacityBytes;
    if (typeof configured === 'number' && configured > 0) return configured;
    return defaultCapBytes();
};

/**
 * Run one LRU eviction pass. Cheap when usage is under the cap — the
 * first three lines short-circuit on the common path. Updates the
 * cache store's `bytesUsed` field at the end of any pass that actually
 * dropped rows.
 */
export const evict = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    if (!isQuotaCapped()) return;

    const cap = await getCurrentCapBytes();
    const used = await cachedBytes();
    if (used <= cap) return;

    const mustFree = used - cap;
    console.info('[cache] eviction: starting pass', { cap, mustFree, used });

    let dropped = 0;
    let droppedCount = 0;

    // Phase 1 — evict thumbnails older than 7 days, oldest first.
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    try {
        const oldRows = await db.thumbnails.where('LastUsed').below(cutoff).sortBy('LastUsed');
        for (const row of oldRows) {
            if (used - dropped <= cap) break;
            try {
                await db.thumbnails.delete(row.ItemId);
                dropped += row.ByteSize;
                droppedCount += 1;
            } catch (err) {
                console.warn('[cache] eviction: failed to delete row', {
                    err,
                    itemId: row.ItemId,
                });
            }
        }
    } catch (err) {
        console.warn('[cache] eviction: phase 1 query failed', { err });
    }

    // Phase 2 — if still over, walk all remaining thumbnails by
    // LastUsed ascending and keep deleting.
    if (used - dropped > cap) {
        try {
            const remaining = await db.thumbnails.orderBy('LastUsed').toArray();
            for (const row of remaining) {
                if (used - dropped <= cap) break;
                try {
                    await db.thumbnails.delete(row.ItemId);
                    dropped += row.ByteSize;
                    droppedCount += 1;
                } catch (err) {
                    console.warn('[cache] eviction: failed to delete row', {
                        err,
                        itemId: row.ItemId,
                    });
                }
            }
        } catch (err) {
            console.warn('[cache] eviction: phase 2 query failed', { err });
        }
    }

    console.info('[cache] eviction: dropped', {
        count: droppedCount,
        freedBytes: dropped,
    });

    if (used - dropped > cap) {
        // Shouldn't happen — thumbnails are the only sized rows we
        // track, so dropping them all must take us under any sane cap.
        // Logged defensively in case ByteSize accounting drifts.
        console.warn('[cache] eviction: cap still exceeded after full thumbnail eviction', {
            cap,
            remaining: used - dropped,
        });
    }

    try {
        useCacheStore.getState().actions.setBytesUsed((await estimateBytes()) ?? undefined);
    } catch (err) {
        console.warn('[cache] eviction: setBytesUsed failed', { err });
    }

    console.info('[cache] eviction: pass complete', {
        dropped: droppedCount,
        finalBytes: used - dropped,
    });
};

/**
 * Wipe every cache table. Powers the "Clear cache → everything"
 * button in the settings dashboard. Pending mutations are included
 * — there is no legitimate state in which the user wants the cache
 * wiped but their queued offline edits preserved.
 */
export const clearAllCacheData = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    await Promise.all([
        db.albums.clear(),
        db.artists.clear(),
        db.favorites.clear(),
        db.genres.clear(),
        db.lyrics.clear(),
        db.mutationQueue.clear(),
        db.playlists.clear(),
        db.playlistSongs.clear(),
        db.songs.clear(),
        db.syncMeta.clear(),
        db.thumbnails.clear(),
    ]);
    console.info('[cache] eviction: cleared all cache tables');
};

/**
 * Wipe only the thumbnails table. Public counterpart to the
 * lower-level `clearThumbnailsTable` in `images.ts`.
 */
export const clearThumbnails = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    await db.thumbnails.clear();
    console.info('[cache] eviction: cleared thumbnails');
};

// Module-load wiring. Listens for thumbnail-write events emitted by
// `images.ts` and triggers an eviction pass. Debounced to coalesce
// burst writes (initial library hydration emits many in quick
// succession; running eviction once per burst is plenty).
if (typeof window !== 'undefined') {
    let pendingTimer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
        if (pendingTimer !== undefined) return;
        pendingTimer = setTimeout(() => {
            pendingTimer = undefined;
            void evict();
        }, 250);
    };
    window.addEventListener('feishin:thumbnail-written', schedule);
}
