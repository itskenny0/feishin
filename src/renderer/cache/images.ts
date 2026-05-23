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
// single upstream fetch. The promise resolves to {blob, bytes} so each
// caller creates its OWN `URL.createObjectURL` (and is responsible for
// revoking it). Sharing the URL string across callers would cause the
// sweep's no-render path (which has nowhere to revoke) to leak — or
// worse, to revoke a URL still in use by a concurrent <BaseImage>.
export interface ResolverResult {
    // The raw blob (cache hit or fresh fetch). Undefined on negative-
    // cache hit, abort, or fetch failure — caller falls back to the
    // original URL.
    blob: Blob | undefined;
    bytes: number;
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
        return result.blob ? URL.createObjectURL(result.blob) : url;
    }

    const task = (async (): Promise<ResolverResult> => {
        try {
            if (signal?.aborted) return { blob: undefined, bytes: 0 };
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
                    return { blob: row.Blob, bytes: 0 };
                }
                const missAt = row.MissAt ?? 0;
                const nowMs = Date.now();
                if (nowMs - missAt < MISS_TTL_MS) {
                    if (nowMs - (row.LastUsed ?? 0) > 3_600_000) {
                        void db.thumbnails.update(itemId, { LastUsed: nowMs });
                    }
                    recordStat('missMarkerHit');
                    return { blob: undefined, bytes: 0 };
                }
                // Stale miss: fall through to refetch.
            }

            const fetchUrl = rewriteUrlToCacheSize(url);
            // Manual AbortController + setTimeout for the per-fetch
            // 20s timeout. `AbortSignal.timeout()` and
            // `AbortSignal.any()` are recent (2023) APIs that aren't
            // universally implemented in Android WebView versions —
            // the user reported workers stuck for 30+ minutes on a
            // single item, which means the previous timeout was a
            // no-op on their device. The manual pattern is supported
            // by every fetch-capable runtime.
            const fetchController = new AbortController();
            let timedOut = false;
            const timeoutId = setTimeout(() => {
                timedOut = true;
                fetchController.abort();
            }, 20_000);
            // Forward the caller's abort signal too.
            const upstreamAbort = signal ? () => fetchController.abort() : undefined;
            if (signal && upstreamAbort) {
                if (signal.aborted) fetchController.abort();
                else signal.addEventListener('abort', upstreamAbort);
            }
            let res: Response;
            try {
                res = await fetch(fetchUrl, {
                    credentials,
                    headers,
                    signal: fetchController.signal,
                });
            } catch (err) {
                if (timedOut) {
                    console.warn('[cache] thumbnail fetch timed out', { itemId });
                    recordStat('failed');
                    return { blob: undefined, bytes: 0 };
                }
                if ((err as Error)?.name === 'AbortError') {
                    return { blob: undefined, bytes: 0 };
                }
                console.warn('[cache] thumbnail fetch threw', {
                    error: (err as Error)?.message ?? String(err),
                    errorName: (err as Error)?.name,
                    hasAuthHeader: Boolean(headers?.Authorization),
                    itemId,
                });
                recordStat('failed');
                return { blob: undefined, bytes: 0 };
            } finally {
                clearTimeout(timeoutId);
                if (signal && upstreamAbort) {
                    signal.removeEventListener('abort', upstreamAbort);
                }
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
                return { blob: undefined, bytes: 0 };
            }

            const blob = await res.blob();
            if (signal?.aborted) return { blob: undefined, bytes: 0 };
            if (db !== getActiveCacheDb()) return { blob: undefined, bytes: 0 };

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
            return { blob, bytes: blob.size };
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return { blob: undefined, bytes: 0 };
            console.warn('[cache] thumbnail fetch failed', {
                error: (err as Error)?.message ?? String(err),
                errorName: (err as Error)?.name,
                itemId,
            });
            recordStat('failed');
            return { blob: undefined, bytes: 0 };
        } finally {
            inFlight.delete(itemId);
        }
    })();

    inFlight.set(itemId, task);
    const result = await task;
    return result.blob ? URL.createObjectURL(result.blob) : url;
};

/**
 * Resolve a thumbnail AND report the byte size that landed in Dexie.
 * Used by the thumbnail sweep — does NOT create a `blob:` URL because
 * the sweep doesn't render anything; the inner task returns the raw
 * Blob and we just throw it away. (Each `BaseImage` consumer creates
 * its own URL via `resolveThumbnail`, with independent revoke
 * lifecycles, so the sweep can't break a concurrent render.)
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

    // Share the in-flight task with `resolveThumbnail`. If the task
    // hasn't started yet, kick it off; both APIs end up awaiting the
    // same inFlight entry. Reading only `result.bytes` means we
    // never createObjectURL on this path, so the sweep can no longer
    // leak per-item blob URLs.
    if (!inFlight.has(itemId)) {
        void resolveThumbnail(itemId, _size, { cacheKey: url, credentials, headers, url }, options);
    }
    const task = inFlight.get(itemId);
    if (!task) return { bytes: 0, url };
    const result = await task;
    return { bytes: result.bytes, url };
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
