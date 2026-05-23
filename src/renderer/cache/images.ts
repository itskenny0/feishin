// Local thumbnail blob store. Reads/writes the `thumbnails` table in the
// active cache DB, with in-flight dedup so concurrent `<CachedImage>`s for
// the same item/size share a single fetch. Falls back to the original URL
// whenever the cache is unavailable or any step throws — image rendering
// must never break because of the cache.

import type { ImageRequest } from '/@/shared/types/domain-types';

import { getActiveCacheDb } from './db';

// Normalises the resolver's request argument so callers can pass either a
// bare URL (legacy callers like `<CachedImage>`) OR a full `ImageRequest`
// with auth headers + credentials.
//
// IMPORTANT: do NOT default `credentials` to 'include'. The previous
// build forced `credentials: 'include'` on every image fetch, which
// turned Jellyfin's image preflight into a credentialed CORS check.
// Jellyfin replies `Access-Control-Allow-Origin: *` to image OPTIONS
// requests, and the browser rejects that combination — every fetch
// then throws `TypeError: Failed to fetch` (this is exactly what the
// user surfaced via the console log viewer). The Authorization header
// alone is enough to authenticate the request.
const normaliseRequest = (
    request: ImageRequest | string,
): { credentials?: RequestCredentials; headers?: Record<string, string>; url: string } => {
    if (typeof request === 'string') {
        return { url: request };
    }
    return {
        credentials: request.credentials,
        headers: request.headers,
        url: request.url,
    };
};

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
 * Resolve a thumbnail to a `blob:` URL backed by the local cache. Accepts
 * either a bare URL (legacy callers) or a full `ImageRequest` so the
 * Authorization header can ride along — on Capacitor / Android there are
 * no cookies, so without the header every Jellyfin image fetch 401s and
 * the Dexie table never gets populated. Falls back to the original URL
 * whenever the cache is unavailable or any step fails.
 */
export const resolveThumbnail = async (
    itemId: string,
    size: number,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<string> => {
    const { credentials, headers, url } = normaliseRequest(request);
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

            let res: Response;
            try {
                res = await fetch(url, { credentials, headers, signal });
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') return undefined;
                console.warn('[cache] thumbnail fetch threw', {
                    error: (err as Error)?.message ?? String(err),
                    errorName: (err as Error)?.name,
                    hasAuthHeader: Boolean(headers?.Authorization),
                    itemId,
                    size,
                    urlHost: (() => {
                        try {
                            return new URL(url).host;
                        } catch {
                            return 'unparseable';
                        }
                    })(),
                });
                return undefined;
            }
            if (!res.ok) {
                // 404 = item has no artwork at this size, which is the
                // norm for many items on most Jellyfin libraries.
                // Silence so the console log viewer doesn't fill with
                // unactionable warnings. Other statuses still warn.
                if (res.status !== 404) {
                    console.warn('[cache] thumbnail HTTP error', {
                        hasAuthHeader: Boolean(headers?.Authorization),
                        itemId,
                        size,
                        status: res.status,
                    });
                }
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
            console.warn('[cache] thumbnail fetch failed', {
                error: (err as Error)?.message ?? String(err),
                errorName: (err as Error)?.name,
                itemId,
                size,
            });
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
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<{ bytes: number; url: string }> => {
    const fallbackUrl = typeof request === 'string' ? request : request.url;
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0, url: fallbackUrl };

    const before = await db.thumbnails.get([itemId, size]);
    const resolved = await resolveThumbnail(itemId, size, request, options);
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
