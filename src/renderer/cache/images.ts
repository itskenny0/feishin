// Local thumbnail blob store. Reads/writes the `thumbnails` table in the
// active cache DB, with in-flight dedup so concurrent `<CachedImage>`s for
// the same item share a single fetch. Falls back to the original URL
// whenever the cache is unavailable or any step throws — image rendering
// must never break because of the cache.

import type { ImageRequest } from '/@/shared/types/domain-types';

import { getActiveCacheDb } from './db';
import { recordStat } from './stats';

import { registerThumbnailUrlCache } from '/@/shared/components/image/use-native-image';

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

// ---------------------------------------------------------------------------
// Shared object-URL keep-alive (refcounted).
//
// Previously every mounted consumer called `URL.createObjectURL` for the
// SAME cached Blob, so scrolling a grid churned thousands of short-lived
// blob: URLs (each holding a live Blob reference until revoked). This map
// keeps ONE object URL per item alive for the lifetime of its mounted
// consumers and revokes it only once the last consumer releases it.
//
// Keyed by `itemId` to match the single-blob-per-item cache model. A
// consumer calls `acquireThumbnailUrl` (which resolves the blob, mints the
// URL once, and bumps the refcount) and `releaseThumbnailUrl` on unmount /
// input change. Legacy callers that still use `resolveThumbnail` directly
// keep their own per-call URL + revoke lifecycle and are unaffected.
interface SharedObjectUrl {
    refCount: number;
    url: string;
}
const sharedObjectUrls = new Map<string, SharedObjectUrl>();

// In-flight dedup for `acquireThumbnailUrl`. Concurrent acquires for the
// same item (the common case while a grid mounts a row of cards) share a
// single resolve + a single `URL.createObjectURL`, then each bumps the
// shared refcount once their promise settles. Without this, racing
// acquires could each mint their own URL and leak all but one.
interface AcquireResult {
    // The shared blob: URL when the resolve produced a cached blob, or
    // undefined on miss/failure (caller falls back to the raw URL).
    objectUrl: string | undefined;
}
const acquireInFlight = new Map<string, Promise<AcquireResult>>();

// Transient hand-off slot: `resolveThumbnail` run with `_wantBlob` stashes
// the resolved Blob here keyed by itemId so the (deduped) acquire task can
// mint exactly one shared object URL. Drained immediately by the task.
const lastResolvedBlob = new Map<string, Blob>();
const takeResolvedBlob = (itemId: string): Blob | undefined => {
    const blob = lastResolvedBlob.get(itemId);
    if (blob) lastResolvedBlob.delete(itemId);
    return blob;
};

/**
 * Acquire a stable, shared `blob:` URL for an item's cached thumbnail,
 * resolving the blob through the cache pipeline if needed. The returned
 * URL is reference-counted: the caller MUST pair every successful acquire
 * (one that returns a `blob:` URL) with a `releaseThumbnailUrl(itemId)`
 * once it is done displaying it. On a cache miss / failure the resolver's
 * fallback (the raw URL) is returned and is NOT refcounted — releasing it
 * is a no-op.
 */
export const acquireThumbnailUrl = async (
    itemId: string,
    size: number,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<string> => {
    const { url } = normaliseRequest(request);

    // Fast path: a live shared URL already exists for this item. Bump the
    // refcount and hand the same string back — no new blob: URL minted.
    const existing = sharedObjectUrls.get(itemId);
    if (existing) {
        existing.refCount += 1;
        return existing.url;
    }

    // Dedup concurrent acquires so the blob is resolved and the object URL
    // minted exactly once, regardless of how many cards mount at the same
    // tick. Each awaiter bumps the refcount below.
    let task = acquireInFlight.get(itemId);
    if (!task) {
        task = (async (): Promise<AcquireResult> => {
            try {
                await resolveThumbnail(itemId, size, request, {
                    ...options,
                    // Stash the raw Blob (if any) without minting a per-call
                    // URL; we mint exactly one shared URL here instead.
                    _wantBlob: true,
                });
                const blob = takeResolvedBlob(itemId);
                if (!blob) {
                    return { objectUrl: undefined };
                }
                // Seed the shared entry with refCount 0; every awaiter
                // (including this one) bumps it to its final value after
                // the task settles.
                const objectUrl = URL.createObjectURL(blob);
                sharedObjectUrls.set(itemId, { refCount: 0, url: objectUrl });
                return { objectUrl };
            } finally {
                acquireInFlight.delete(itemId);
            }
        })();
        acquireInFlight.set(itemId, task);
    }

    const result = await task;
    if (!result.objectUrl) {
        // Cache miss / failure — fall back to the raw URL (un-refcounted).
        return url;
    }
    // The shared entry may already have been fully released + revoked
    // between the task settling and this awaiter resuming (rare: every
    // earlier awaiter mounted and unmounted before we got here). If so the
    // URL is dead; fall back to the raw URL and let a fresh acquire run.
    const entry = sharedObjectUrls.get(itemId);
    if (!entry || entry.url !== result.objectUrl) {
        return url;
    }
    entry.refCount += 1;
    return entry.url;
};

/**
 * Release a previously-acquired shared thumbnail URL. Decrements the
 * refcount and revokes the underlying object URL once the last consumer
 * lets go. Safe to call with a non-shared (raw fallback) itemId — it is a
 * no-op when the item isn't tracked.
 */
export const releaseThumbnailUrl = (itemId: string): void => {
    const entry = sharedObjectUrls.get(itemId);
    if (!entry) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
        sharedObjectUrls.delete(itemId);
        try {
            URL.revokeObjectURL(entry.url);
        } catch {
            // Revoke can throw on already-revoked / invalid URLs in some
            // runtimes; nothing actionable, the entry is already gone.
        }
    }
};

// Sampled-logging counters. Hits fire on every render; logging each one
// would flood devtools, so we sample. Misses are interesting and always log.
let hitCount = 0;
let missCount = 0;

const HIT_LOG_SAMPLE = 50;

// Lookup-attempt diagnostic counter. Logs the first N resolver calls
// from anywhere (sweep + BaseImage) with hit / miss / no-id outcome
// so the user can verify the tracklist is actually hitting the cache
// for songs whose albums are cached. After this many attempts we stop
// logging to avoid spam.
let lookupAttempts = 0;
const LOOKUP_LOG_LIMIT = 25;

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
    // Internal flag used by resolveThumbnailWithBytes. When true the
    // resolver skips URL.createObjectURL so the sweep does not register
    // thousands of blob: URLs that are never revoked. Without this flag
    // each sweep item accumulated a live blob reference in the browser's
    // URL registry (the string was discarded but the registry held the
    // Blob), causing progressive memory growth that eventually triggered
    // frequent GC pauses and dropped throughput below 0.1 items/sec.
    _skipBlobUrl?: boolean;
    // Internal flag used by acquireThumbnailUrl. When true the resolver
    // stashes the resolved Blob on the shared hand-off slot (keyed by
    // itemId) so the acquire path can mint exactly ONE shared object URL.
    // Implies _skipBlobUrl semantics for the return value.
    _wantBlob?: boolean;
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
            // Early-attempt diagnostic — logs what the resolver is
            // being asked to look up and whether the cache hit.
            // Bounded so it doesn't spam.
            if (lookupAttempts < LOOKUP_LOG_LIMIT) {
                lookupAttempts += 1;
                console.info('[cache] resolver lookup', {
                    attempt: lookupAttempts,
                    found: Boolean(row),
                    hasBlob: Boolean(row?.Blob),
                    isMissMarker: Boolean(row && !row.Blob && row.MissAt),
                    itemId,
                    urlPath: (() => {
                        try {
                            return new URL(url).pathname;
                        } catch {
                            return '<unparseable>';
                        }
                    })(),
                });
            }
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

            const contentType = res.headers.get('content-type') ?? '';
            const contentLengthHeader = res.headers.get('content-length');
            const blob = await res.blob();
            if (signal?.aborted) return { blob: undefined, bytes: 0 };
            if (db !== getActiveCacheDb()) return { blob: undefined, bytes: 0 };

            // Diagnostic: log content-type + size + URL host for every
            // fresh fetch where the result looks suspiciously small.
            // Real 1024px JPEG album art is usually 50-200 KB; anything
            // under 4 KB is almost certainly either a placeholder, an
            // error page being read as a blob, or the server ignoring
            // the requested size and returning a tiny default.
            if (blob.size < 4096) {
                console.warn('[cache] suspiciously small thumbnail', {
                    blobBytes: blob.size,
                    contentLengthHeader,
                    contentType,
                    itemId,
                    requestedSize: MAX_CACHE_SIZE,
                    urlHost: (() => {
                        try {
                            return new URL(fetchUrl).host;
                        } catch {
                            return 'unparseable';
                        }
                    })(),
                    urlPath: (() => {
                        try {
                            const u = new URL(fetchUrl);
                            return u.pathname + u.search;
                        } catch {
                            return '<unparseable>';
                        }
                    })(),
                });
            }

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
    if (options?._wantBlob) {
        // Hand the Blob off to acquireThumbnailUrl, which mints exactly
        // one shared object URL. Return the raw URL as a sentinel — the
        // acquire path keys off the stashed Blob, not this return value.
        if (result.blob) lastResolvedBlob.set(itemId, result.blob);
        return url;
    }
    if (options?._skipBlobUrl) return url;
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
        // Pass _skipBlobUrl so resolveThumbnail does not call
        // URL.createObjectURL — the returned string is discarded but the
        // browser URL registry would hold the Blob indefinitely, causing
        // progressive heap growth during the sweep (hundreds of MB after
        // ~1k thumbnails → GC pressure → throughput collapses to <0.1/s).
        void resolveThumbnail(
            itemId,
            _size,
            { cacheKey: url, credentials, headers, url },
            { ...options, _skipBlobUrl: true },
        );
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

// Bridge the refcounted shared-URL cache into the shared `useNativeImage`
// hook. Registered eagerly at module load so the first `<ItemImage>` mount
// can reuse object URLs across remounts during scroll instead of churning
// one blob: URL per mount. The hook falls back to the per-call resolver
// when this isn't registered (e.g. the shared bundle imported outside the
// renderer), so registration is purely additive.
registerThumbnailUrlCache(acquireThumbnailUrl, releaseThumbnailUrl);
