// Local thumbnail blob store. Reads/writes the `thumbnails` table in the
// active cache DB, with in-flight dedup so concurrent `<CachedImage>`s for
// the same item/size share a single fetch. Falls back to the original URL
// whenever the cache is unavailable or any step throws — image rendering
// must never break because of the cache.

import { getActiveCacheDb } from './db';

// Module-level dedup map. Keyed by `${itemId}:${size}`. Promises resolve to
// the blob URL when the cache pipeline succeeds, or `undefined` when the
// caller should fall back to the raw URL.
const inFlight = new Map<string, Promise<string | undefined>>();

// Sampled-logging counters. Hits fire on every render; logging each one
// would flood devtools, so we sample. Misses are interesting and always log.
let hitCount = 0;
let missCount = 0;

const HIT_LOG_SAMPLE = 50;

const keyFor = (itemId: string, size: number): string => `${itemId}:${size}`;

const emitWritten = (): void => {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('feishin:thumbnail-written'));
    }
};

export interface ResolveThumbnailOptions {
    // When set, the fetch is aborted when the signal fires. The cache
    // pipeline returns `undefined` (caller falls back to the raw URL).
    signal?: AbortSignal;
}

/**
 * Resolve a thumbnail to a `blob:` URL backed by the local cache. Falls
 * back to the original `url` when the cache is disabled or any step fails.
 */
export const resolveThumbnail = async (
    itemId: string,
    size: number,
    url: string,
    options?: ResolveThumbnailOptions,
): Promise<string> => {
    const db = getActiveCacheDb();
    if (!db) return url;

    const signal = options?.signal;
    if (signal?.aborted) return url;

    const key = keyFor(itemId, size);
    const existing = inFlight.get(key);
    if (existing) {
        const result = await existing;
        return result ?? url;
    }

    const task = (async (): Promise<string | undefined> => {
        try {
            if (signal?.aborted) return undefined;
            const row = await db.thumbnails.get([itemId, size]);
            if (row) {
                await db.thumbnails.update([itemId, size], { LastUsed: Date.now() });
                hitCount += 1;
                if (hitCount % HIT_LOG_SAMPLE === 0) {
                    console.info('[cache] thumbnail hits', { total: hitCount });
                }
                return URL.createObjectURL(row.Blob);
            }

            const res = await fetch(url, { credentials: 'include', signal });
            if (!res.ok) {
                console.warn('[cache] thumbnail fetch failed', {
                    itemId,
                    size,
                    status: res.status,
                });
                return undefined;
            }

            const blob = await res.blob();
            if (signal?.aborted) return undefined;

            // The lifecycle Job 2 closes the active DB when the user
            // disables the cache. The handle we captured at task entry
            // may already be closed if disable happened mid-fetch; bail
            // out before the put() throws.
            if (db !== getActiveCacheDb()) return undefined;

            await db.thumbnails.put({
                __cachedAt: Date.now(),
                Blob: blob,
                ByteSize: blob.size,
                Etag: res.headers.get('etag') ?? undefined,
                ItemId: itemId,
                LastUsed: Date.now(),
                Size: size,
            });
            emitWritten();
            missCount += 1;
            console.info('[cache] thumbnail fetched', {
                bytes: blob.size,
                itemId,
                missesSoFar: missCount,
                size,
            });
            return URL.createObjectURL(blob);
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return undefined;
            console.warn('[cache] thumbnail fetch failed', { err, itemId, size });
            return undefined;
        } finally {
            inFlight.delete(key);
        }
    })();

    inFlight.set(key, task);
    const result = await task;
    return result ?? url;
};

/**
 * Resolve a thumbnail AND report the byte size that landed in Dexie.
 * Used by the thumbnail sweep to populate the progress chip's
 * downloaded-bytes counter. Returns `{ bytes: 0 }` on cache hit / abort /
 * fetch failure so the sweep can still increment its done counter
 * uniformly.
 */
export const resolveThumbnailWithBytes = async (
    itemId: string,
    size: number,
    url: string,
    options?: ResolveThumbnailOptions,
): Promise<{ bytes: number; url: string }> => {
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0, url };

    const before = await db.thumbnails.get([itemId, size]);
    const resolved = await resolveThumbnail(itemId, size, url, options);
    if (before) return { bytes: 0, url: resolved };
    const after = await db.thumbnails.get([itemId, size]);
    return { bytes: after?.ByteSize ?? 0, url: resolved };
};

/**
 * Empty the thumbnails table. Used by `Clear cache → thumbnails`.
 */
export const clearThumbnailsTable = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    await db.thumbnails.clear();
    console.info('[cache] thumbnails cleared');
};
