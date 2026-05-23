// Local thumbnail blob store. Reads/writes the `thumbnails` table in the
// active cache DB, with in-flight dedup so concurrent `<CachedImage>`s for
// the same item share a single fetch. Falls back to the original URL
// whenever the cache is unavailable or any step throws — image rendering
// must never break because of the cache.

import type { ImageRequest } from '/@/shared/types/domain-types';

import { getActiveCacheDb } from './db';
import { recordStat } from './stats';

// Single cache size for every blob. Covers any reasonable mobile / tablet
// / desktop full-screen player display; on lower-DPR display surfaces the
// browser downscales cleanly via CSS. Exposed so the sweep can request
// the same upstream resize the resolver does.
export const MAX_CACHE_SIZE = 1024;

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

// Rewrite any size-bearing query params on the upstream URL to
// MAX_CACHE_SIZE so every cache fetch lands the same blob regardless of
// the caller's display size. Jellyfin uses `width`/`height`; Subsonic
// uses `size`; we cover the wider Jellyfin family (`fillWidth`,
// `fillHeight`, `maxWidth`, `maxHeight`) defensively. If the URL can't
// be parsed (some Capacitor schemes) we return it unchanged and let the
// browser fetch what the caller provided.
const rewriteUrlToCacheSize = (url: string): string => {
    try {
        const parsed = new URL(url);
        const params = parsed.searchParams;
        const target = String(MAX_CACHE_SIZE);
        let touched = false;
        for (const key of ['width', 'height', 'fillWidth', 'fillHeight', 'maxWidth', 'maxHeight']) {
            if (params.has(key)) {
                params.set(key, target);
                touched = true;
            }
        }
        // Subsonic uses `size`. Some servers also expose `imageSize`.
        for (const key of ['size', 'imageSize']) {
            if (params.has(key)) {
                params.set(key, target);
                touched = true;
            }
        }
        if (!touched) return url;
        return parsed.toString();
    } catch {
        return url;
    }
};

// Module-level dedup map. Keyed by `itemId` — any concurrent calls for
// the same item, regardless of caller-supplied display size, share the
// single upstream fetch. The promise resolves to {url, bytes} so the
// sweep's `resolveThumbnailWithBytes` wrapper can report download size
// without an extra Dexie round-trip.
export interface ResolverResult {
    bytes: number;
    url: string | undefined;
}
const inFlight = new Map<string, Promise<ResolverResult>>();

// Sampled-logging counters. Hits fire on every render; logging each one
// would flood devtools, so we sample. Misses are interesting and always log.
let hitCount = 0;
let missCount = 0;

const HIT_LOG_SAMPLE = 50;

// Negative-cache TTL: how long a 404 marker is honored before we let
// the resolver try again. Most Jellyfin libraries don't grow artwork
// out of thin air, so a week between retries keeps the table small
// without making the user manually clear it if they re-tag an album.
const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
 * the Dexie table never gets populated.
 *
 * The `size` argument is the caller's desired display size; the cache
 * IGNORES it for keying (one blob per item) and the upstream fetch
 * always requests `MAX_CACHE_SIZE`, letting the browser downscale via
 * CSS for smaller surfaces. Falls back to the original URL whenever the
 * cache is unavailable or any step fails.
 */
export const resolveThumbnail = async (
    itemId: string,
    _size: number,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<string> => {
    const { credentials, headers, url } = normaliseRequest(request);
    const db = getActiveCacheDb();
    if (!db) return url;

    const signal = options?.signal;
    if (signal?.aborted) return url;

    const existing = inFlight.get(itemId);
    if (existing) {
        const result = await existing;
        return result.url ?? url;
    }

    const task = (async (): Promise<ResolverResult> => {
        try {
            if (signal?.aborted) return { bytes: 0, url: undefined };
            const row = await db.thumbnails.get(itemId);
            if (row) {
                if (row.Blob) {
                    // Throttle LastUsed writes to once per hour per
                    // item. Without this, every cache HIT issues an
                    // IndexedDB write — under a 24-worker sweep that
                    // means hundreds of writes/sec just to bump a
                    // timestamp, all serialized against the sweep's
                    // own put()s. LRU eviction only consults LastUsed
                    // during a (rare) sweep pass; per-render precision
                    // is overkill.
                    const now = Date.now();
                    if (now - (row.LastUsed ?? 0) > 3_600_000) {
                        void db.thumbnails.update(itemId, { LastUsed: now });
                    }
                    hitCount += 1;
                    recordStat('blobHit');
                    if (hitCount % HIT_LOG_SAMPLE === 0) {
                        console.info('[cache] thumbnail hits', { total: hitCount });
                    }
                    return { bytes: 0, url: URL.createObjectURL(row.Blob) };
                }
                const missAt = row.MissAt ?? 0;
                const nowMs = Date.now();
                if (nowMs - missAt < MISS_TTL_MS) {
                    if (nowMs - (row.LastUsed ?? 0) > 3_600_000) {
                        void db.thumbnails.update(itemId, { LastUsed: nowMs });
                    }
                    recordStat('missMarkerHit');
                    return { bytes: 0, url: undefined };
                }
                // Stale miss: fall through to refetch.
            }

            const fetchUrl = rewriteUrlToCacheSize(url);
            const timeoutAt = AbortSignal.timeout(20_000);
            const combinedSignal = signal ? AbortSignal.any([signal, timeoutAt]) : timeoutAt;
            let res: Response;
            try {
                res = await fetch(fetchUrl, { credentials, headers, signal: combinedSignal });
            } catch (err) {
                if ((err as Error)?.name === 'AbortError') {
                    return { bytes: 0, url: undefined };
                }
                if ((err as Error)?.name === 'TimeoutError') {
                    console.warn('[cache] thumbnail fetch timed out', { itemId });
                    recordStat('failed');
                    return { bytes: 0, url: undefined };
                }
                console.warn('[cache] thumbnail fetch threw', {
                    error: (err as Error)?.message ?? String(err),
                    errorName: (err as Error)?.name,
                    hasAuthHeader: Boolean(headers?.Authorization),
                    itemId,
                });
                recordStat('failed');
                return { bytes: 0, url: undefined };
            }
            if (!res.ok) {
                if (res.status === 404) {
                    if (db === getActiveCacheDb()) {
                        try {
                            await db.thumbnails.put({
                                __cachedAt: Date.now(),
                                Blob: undefined,
                                ByteSize: 0,
                                Etag: undefined,
                                ItemId: itemId,
                                LastUsed: Date.now(),
                                MissAt: Date.now(),
                                Size: MAX_CACHE_SIZE,
                            });
                            recordStat('missWrite');
                        } catch (err) {
                            console.warn('[cache] thumbnail miss-write failed', {
                                error: (err as Error)?.message,
                                itemId,
                            });
                        }
                    }
                } else {
                    console.warn('[cache] thumbnail HTTP error', {
                        hasAuthHeader: Boolean(headers?.Authorization),
                        itemId,
                        status: res.status,
                    });
                    recordStat('failed');
                }
                return { bytes: 0, url: undefined };
            }

            const blob = await res.blob();
            if (signal?.aborted) return { bytes: 0, url: undefined };
            if (db !== getActiveCacheDb()) return { bytes: 0, url: undefined };

            await db.thumbnails.put({
                __cachedAt: Date.now(),
                Blob: blob,
                ByteSize: blob.size,
                Etag: res.headers.get('etag') ?? undefined,
                ItemId: itemId,
                LastUsed: Date.now(),
                MissAt: undefined,
                Size: MAX_CACHE_SIZE,
            });
            emitWritten();
            missCount += 1;
            recordStat('fetched', blob.size);
            console.info('[cache] thumbnail fetched', {
                bytes: blob.size,
                itemId,
                missesSoFar: missCount,
            });
            return { bytes: blob.size, url: URL.createObjectURL(blob) };
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return { bytes: 0, url: undefined };
            console.warn('[cache] thumbnail fetch failed', {
                error: (err as Error)?.message ?? String(err),
                errorName: (err as Error)?.name,
                itemId,
            });
            recordStat('failed');
            return { bytes: 0, url: undefined };
        } finally {
            inFlight.delete(itemId);
        }
    })();

    inFlight.set(itemId, task);
    const result = (await task).url;
    return result ?? url;
};

/**
 * Resolve a thumbnail AND report the byte size that landed in Dexie.
 * Used by the thumbnail sweep to populate the progress chip's
 * downloaded-bytes counter. The inner resolver task now returns
 * `{url, bytes}` directly, so we don't need the before/after Dexie
 * round-trip the previous implementation paid per fetch — eliminating
 * 2 IndexedDB reads per sweep item.
 */
export const resolveThumbnailWithBytes = async (
    itemId: string,
    _size: number,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<{ bytes: number; url: string }> => {
    const { credentials, headers, url } = normaliseRequest(request);
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0, url };

    const signal = options?.signal;
    if (signal?.aborted) return { bytes: 0, url };

    // Share the in-flight task with `resolveThumbnail` — both APIs do
    // the same work; only the return shape differs. If the task hasn't
    // started yet (rare in the sweep, since the sweep is the only
    // caller, but possible if BaseImage raced ahead), kick it off via
    // resolveThumbnail and then await the same map entry. The shared
    // task is the same one resolveThumbnail uses.
    if (!inFlight.has(itemId)) {
        // Pre-seed by calling resolveThumbnail; it sets inFlight before
        // awaiting. Swallow its return — we want the {url, bytes} shape
        // from the map entry below.
        void resolveThumbnail(itemId, _size, { cacheKey: url, credentials, headers, url }, options);
    }
    const task = inFlight.get(itemId);
    if (!task) return { bytes: 0, url };
    const result = await task;
    return { bytes: result.bytes, url: result.url ?? url };
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
