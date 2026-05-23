// Thumbnail pre-cache sweep. Iterates every album / artist / playlist row
// in Dexie and fetches its thumbnail blob at the user-configured set of
// sizes via `resolveThumbnail`. The same Dexie `thumbnails` table that
// the lazy `<BaseImage>` path writes to is reused, so subsequent mounts
// hit the cache regardless of whether the pre-cache or the lazy path
// landed the row first.
//
// The sweep is explicitly opt-in: the user picks which `imageRes` size
// buckets to pre-cache via Settings -> Library sync. With no sizes picked
// the sweep is a no-op and we leave the lazy fetch unchanged.

import type { ServerListItem } from '/@/shared/types/domain-types';

import { api } from '/@/renderer/api';
import { getActiveCacheDb } from '/@/renderer/cache/db';
import { resolveThumbnailWithBytes } from '/@/renderer/cache/images';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store';
import { LibraryItem } from '/@/shared/types/domain-types';

// Concurrency cap on the parallel thumbnail fetches. The user-tunable
// `localCache.thumbnailConcurrency` setting overrides this default at
// sweep start. 24 is a sensible default on modern HTTP/2 servers — the
// 6 we used initially was a relic from when fetches were failing fast
// against the CORS preflight bug.
const DEFAULT_CONCURRENCY = 24;
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 64;

type EntityKind = 'album' | 'artist' | 'playlist';

interface PendingThumbnail {
    itemId: string;
    itemType: LibraryItem;
    kind: EntityKind;
    size: number;
}

/**
 * Collect the (id, type, size) triples we want to fetch. Reads each
 * Dexie table once and crosses each row with each selected size bucket.
 * We attempt every row that has an `id` — `imageId` is unreliable on
 * some servers (Jellyfin omits it from list endpoints even when the
 * entity has artwork accessible via the per-item endpoint), so the
 * earlier `if (!row.Payload?.imageId)` guard was rejecting most
 * candidates. Let the server return 404 instead.
 */
const collectPending = async (
    sizes: number[],
): Promise<PendingThumbnail[]> => {
    const db = getActiveCacheDb();
    if (!db) return [];
    const out: PendingThumbnail[] = [];

    const albums = await db.albums.toArray();
    for (const row of albums) {
        if (!row.Id) continue;
        for (const size of sizes) {
            out.push({
                itemId: row.Id,
                itemType: LibraryItem.ALBUM,
                kind: 'album',
                size,
            });
        }
    }

    const artists = await db.artists.toArray();
    for (const row of artists) {
        if (!row.Id) continue;
        for (const size of sizes) {
            out.push({
                itemId: row.Id,
                itemType: LibraryItem.ALBUM_ARTIST,
                kind: 'artist',
                size,
            });
        }
    }

    const playlists = await db.playlists.toArray();
    for (const row of playlists) {
        if (!row.Id) continue;
        for (const size of sizes) {
            out.push({
                itemId: row.Id,
                itemType: LibraryItem.PLAYLIST,
                kind: 'playlist',
                size,
            });
        }
    }

    return out;
};

/**
 * Run one thumbnail fetch through the shared resolver. The resolver
 * dedups in-flight requests, checks the existing Dexie row, and writes
 * back to the table on miss — we don't have to do any of that here.
 *
 * `existingKeys` is a pre-computed set of `${itemId}:${size}` strings
 * built ONCE at sweep start. Without it, each of the 64 workers ran
 * its own `db.thumbnails.get()` against IndexedDB just to discover a
 * row already existed; the user reported 2.6 items/sec on re-syncs
 * because every cached item paid that Dexie round-trip. Bypassing the
 * lookup makes already-cached items effectively free.
 */
const fetchOne = async (
    pending: PendingThumbnail,
    serverId: string,
    signal: AbortSignal,
    existingKeys: Set<string>,
): Promise<{ bytes: number }> => {
    if (signal.aborted) return { bytes: 0 };

    // Cheap in-memory skip for already-cached items.
    const key = `${pending.itemId}:${pending.size}`;
    if (existingKeys.has(key)) return { bytes: 0 };

    const request = api.controller.getImageRequest({
        apiClientProps: { serverId },
        query: { id: pending.itemId, itemType: pending.itemType, size: pending.size },
    });
    if (!request) return { bytes: 0 };
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0 };

    const { bytes } = await resolveThumbnailWithBytes(
        pending.itemId,
        pending.size,
        request,
        { signal },
    );
    if (bytes > 0) existingKeys.add(key);
    return { bytes };
};

/**
 * Run the thumbnail pre-cache sweep for the given server. No-op when
 * the user hasn't picked any thumbnail sizes.
 */
export const runThumbnailsSweep = async (
    args: { signal: AbortSignal },
    server: ServerListItem,
): Promise<void> => {
    const { signal } = args;
    const localCache = useSettingsStore.getState().localCache;
    const general = useSettingsStore.getState().general;
    const buckets = localCache?.thumbnailSizes ?? [];
    if (buckets.length === 0) {
        console.info('[cache] thumbnails sweep: no sizes selected, skipping');
        return;
    }

    const sizes = buckets
        .map((b) => general.imageRes[b])
        .filter((n): n is number => typeof n === 'number' && n > 0);
    if (sizes.length === 0) {
        console.warn('[cache] thumbnails sweep: configured buckets resolved to no sizes');
        return;
    }

    const pending = await collectPending(sizes);
    const total = pending.length;
    if (total === 0) {
        console.info('[cache] thumbnails sweep: no items to pre-cache yet');
        return;
    }

    // Honour the user-tunable concurrency setting. Clamped to the
    // [MIN_CONCURRENCY, MAX_CONCURRENCY] range to keep typos / hostile
    // values from saturating the network or starving the worker.
    const configured = useSettingsStore.getState().localCache?.thumbnailConcurrency;
    const concurrency = Math.min(
        MAX_CONCURRENCY,
        Math.max(MIN_CONCURRENCY, configured ?? DEFAULT_CONCURRENCY),
    );

    console.info('[cache] thumbnails sweep: starting', {
        concurrency,
        items: total,
        serverId: server.id,
        sizes,
    });

    const actions = useCacheStore.getState().actions;
    const startedAt = Date.now();
    let done = 0;
    let bytesDownloaded = 0;

    // Pre-fetch every existing thumbnail row's [itemId, size] pair so the
    // worker pool can skip them without a Dexie round-trip per item. On a
    // re-sync where the cache is mostly warm this turns a 2.6 items/sec
    // crawl into a near-instant scan.
    const db = getActiveCacheDb();
    const existingKeys = new Set<string>();
    if (db) {
        try {
            const rows = await db.thumbnails.toArray();
            for (const row of rows) {
                existingKeys.add(`${row.ItemId}:${row.Size}`);
            }
            console.info('[cache] thumbnails sweep: prefetched existing keys', {
                count: existingKeys.size,
            });
        } catch (err) {
            console.warn('[cache] thumbnails sweep: prefetch failed', err);
        }
    }

    // Throttle setSweep so the dashboard / sync chip don't re-render at
    // worker speed (which was causing the main thread to choke). One
    // update every 50ms is more than the 20fps the UI promises.
    const SWEEP_UPDATE_MS = 50;
    let lastUpdateAt = 0;
    const flushProgress = (force = false) => {
        const now = Date.now();
        if (!force && now - lastUpdateAt < SWEEP_UPDATE_MS) return;
        lastUpdateAt = now;
        const elapsed = Math.max(1, (now - startedAt) / 1000);
        const estimatedTotalBytes =
            done > 0 ? Math.round(bytesDownloaded * (total / done)) : undefined;
        actions.setSweep({
            entity: 'thumbnails',
            progress: {
                bytesDownloaded,
                bytesPerSec: bytesDownloaded / elapsed,
                done,
                estimatedTotalBytes,
                itemsPerSec: done / elapsed,
                startedAt,
                total,
            },
        });
    };

    flushProgress(true);

    // Simple bounded-concurrency worker pool.
    const queue = pending.slice();
    const workers: Promise<void>[] = [];

    const work = async (): Promise<void> => {
        while (queue.length > 0) {
            if (signal.aborted) return;
            const next = queue.shift();
            if (!next) return;
            try {
                const { bytes } = await fetchOne(next, server.id, signal, existingKeys);
                bytesDownloaded += bytes;
            } catch (err) {
                console.warn('[cache] thumbnails sweep: fetch failed', {
                    err: (err as Error).message,
                    item: next.itemId,
                });
            }
            done += 1;
            flushProgress();
        }
    };

    for (let i = 0; i < concurrency; i += 1) {
        workers.push(work());
    }

    await Promise.all(workers);

    // Make sure the final tick lands in the store even if it would
    // have been throttled — the user should see the completed total.
    flushProgress(true);

    if (signal.aborted) {
        console.warn('[cache] thumbnails sweep: aborted', { done, total });
        return;
    }

    console.info('[cache] thumbnails sweep: complete', {
        bytes: bytesDownloaded,
        durationMs: Date.now() - startedAt,
        items: total,
        skipped: existingKeys.size,
    });
};
