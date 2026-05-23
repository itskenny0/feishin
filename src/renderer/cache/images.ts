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

/**
 * Resolve a thumbnail to a `blob:` URL backed by the local cache. Falls
 * back to the original `url` when the cache is disabled or any step fails.
 */
export const resolveThumbnail = async (
    itemId: string,
    size: number,
    url: string,
): Promise<string> => {
    const db = getActiveCacheDb();
    if (!db) return url;

    const key = keyFor(itemId, size);
    const existing = inFlight.get(key);
    if (existing) {
        const result = await existing;
        return result ?? url;
    }

    const task = (async (): Promise<string | undefined> => {
        try {
            const row = await db.thumbnails.get([itemId, size]);
            if (row) {
                await db.thumbnails.update([itemId, size], { LastUsed: Date.now() });
                hitCount += 1;
                if (hitCount % HIT_LOG_SAMPLE === 0) {
                    console.info('[cache] thumbnail hits', { total: hitCount });
                }
                return URL.createObjectURL(row.Blob);
            }

            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) {
                console.warn('[cache] thumbnail fetch failed', {
                    itemId,
                    size,
                    status: res.status,
                });
                return undefined;
            }

            const blob = await res.blob();
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
 * Empty the thumbnails table. Used by `Clear cache → thumbnails`.
 */
export const clearThumbnailsTable = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) return;
    await db.thumbnails.clear();
    console.info('[cache] thumbnails cleared');
};
