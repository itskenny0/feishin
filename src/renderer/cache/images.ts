// Local thumbnail blob store. Reads/writes the `thumbnails` table in the
// active cache DB, with in-flight dedup so concurrent `<CachedImage>`s for
// the same item share a single fetch. Falls back to the original URL
// whenever the cache is unavailable or any step throws — image rendering
// must never break because of the cache.

import type { ImageRequest } from '/@/shared/types/domain-types';

import type { CachedThumbnail } from './types';

import { backendForRef, getActiveBackend } from './backends/active-backend';
import { refForRow, rowFieldsForRef } from './backends/types';
import { awaitActiveCacheDb, getActiveCacheDb } from './db';
import { recordStat } from './stats';
import {
    isRowHashStale,
    nearestLargerVariant,
    variantConfigHash,
    type VariantName,
} from './variant-config';

import {
    getIsOnline,
    markServerReachable,
    markServerUnreachable,
    subscribeIsOnline,
} from '/@/renderer/lib/network-status';
import {
    DEFAULT_IMAGE_VARIANTS,
    type LocalCacheImageVariants,
    useSettingsStore,
} from '/@/renderer/store/settings.store';
import {
    NO_ARTWORK_URL,
    registerThumbnailDegradedProbe,
    registerThumbnailUrlCache,
} from '/@/shared/components/image/use-native-image';

// Single cache size for every blob. Covers any reasonable mobile / tablet
// / desktop full-screen player display; on lower-DPR display surfaces the
// browser downscales cleanly via CSS. Exposed so the sweep can request
// the same upstream resize the resolver does.
export const MAX_CACHE_SIZE = 1024;

// The variant served to callers that haven't (yet) declared a surface
// bucket — the original/full-resolution cover. Task 6 wires `ItemImage`'s
// surface `type` through as the real variant; until then (and for the
// legacy `<CachedImage>` / lifecycle resolver path) we resolve against the
// full-size bucket. `0` px in the config means "original", which matches
// the historical single-blob-at-MAX_CACHE_SIZE behaviour closely enough.
export const DEFAULT_VARIANT = 'fullScreen';

// Normalise the resolver's 2nd argument. Historically this was the caller's
// numeric display `size` (ignored for keying); the variant cache (schema
// v11) keys on the surface bucket instead. Legacy callers that still pass a
// number — or anything non-string — collapse to the full-size variant so
// they keep working until Task 6 threads the real bucket through.
const normaliseVariant = (variant: number | string | undefined): string =>
    typeof variant === 'string' && variant.length > 0 ? variant : DEFAULT_VARIANT;

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

// Size-bearing query params we know how to rewrite. Jellyfin uses
// `width`/`height` (+ the `fillWidth`/`fillHeight`/`maxWidth`/`maxHeight`
// family); Subsonic/Navidrome use `size` (some servers also expose
// `imageSize`).
const SIZE_PARAMS = [
    'width',
    'height',
    'fillWidth',
    'fillHeight',
    'maxWidth',
    'maxHeight',
    'size',
    'imageSize',
];

// Rewrite any size-bearing query params on the upstream URL to a target
// pixel size, so a "download per size" variant fetch lands the exact
// resolution the surface needs. `px === 0` means "original" — we strip the
// size params entirely so the server returns its native-resolution cover.
// If the URL can't be parsed (some Capacitor schemes) we return it
// unchanged and let the browser fetch what the caller provided.
export const rewriteUrlToVariantSize = (url: string, px: number): string => {
    try {
        const parsed = new URL(url);
        const params = parsed.searchParams;
        const original = px === 0;
        const target = String(px);
        let touched = false;
        for (const key of SIZE_PARAMS) {
            if (params.has(key)) {
                if (original) params.delete(key);
                else params.set(key, target);
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
    // True when the miss is AUTHORITATIVE: the server already told us this
    // item has no artwork (a fresh 404 / negative-cache marker). Display
    // callers surface their placeholder immediately instead of re-fetching
    // the raw URL — which 404s again online and, against an unreachable
    // server, leaves the cell in a skeleton for the full fetch timeout.
    noArtwork?: boolean;
}
const inFlight = new Map<string, Promise<ResolverResult>>();

// Consecutive image-fetch transport timeouts across the whole resolver. A
// SINGLE slow cover (one 20s stall) used to flip the global offline latch and
// park every cache sweep "offline" — far too trigger-happy when tens of
// thousands of covers sweep a phone-hosted server. Require a short STREAK of
// timeouts with no intervening HTTP response (a genuinely dead host, not one
// slow item) before latching offline. Reset on ANY response (even an error
// status — that still proves the server is reachable).
const IMAGE_TIMEOUT_LATCH_THRESHOLD = 3;
let consecutiveImageTimeouts = 0;

// ---------------------------------------------------------------------------
// Bounded concurrency for DISPLAY-path resolves.
//
// A grid mounting 50+ cells used to kick 50 concurrent resolver tasks — 50
// racing IndexedDB gets (serialized against any active sweep's writes) and,
// on a cold cache, 50 simultaneous network fetches + blob handling. The
// renderer visibly hung while the burst drained. The gate below caps how many
// resolver tasks run their heavy section at once; waiters are woken LIFO so
// the most recently requested covers — the ones currently on screen during a
// scroll — are served first. Sweep-path resolves (_skipBlobUrl) bypass the
// gate: the sweep already runs under its own worker pool and must not be
// throttled by (or starve) the display path.
const RESOLVE_CONCURRENCY = 8;
let resolveActive = 0;
const resolveWaiters: (() => void)[] = [];

const acquireResolveSlot = async (): Promise<void> => {
    if (resolveActive < RESOLVE_CONCURRENCY) {
        resolveActive += 1;
        return;
    }
    // The slot is inherited from the releaser — no increment on wake.
    await new Promise<void>((resolve) => {
        resolveWaiters.push(resolve);
    });
};

const releaseResolveSlot = (): void => {
    const next = resolveWaiters.pop(); // LIFO: newest request first
    if (next) {
        next();
        return;
    }
    resolveActive -= 1;
};

// Compose the per-variant key used by every dedup / shared-URL map below.
// Two consumers of the SAME (item, surface bucket) share one fetch + one
// object URL; a different bucket of the same item resolves independently.
const variantKey = (itemId: string, variant: string): string => `${itemId}::${variant}`;

// ---------------------------------------------------------------------------
// Blob backend bridge for thumbnails.
//
// Thumbnail bytes go through the same pluggable backend as offline audio:
// inline in the Dexie row (idb backend, the historical layout) or in a file
// under the chosen Android volume (capacitor-fs backend). The row carries a
// Path instead of a Blob in the latter case. We "rehydrate" fs rows on read —
// loading the file into `row.Blob` right after each Dexie fetch — so every
// downstream object-URL / size / staleness code path stays byte-for-byte the
// same regardless of where the bytes live. Image blobs are small, so loading
// them into memory (rather than using convertFileSrc) keeps the existing
// shared-object-URL refcount machinery intact.

const thumbBackendKey = (itemId: string, variant: string): string => `${itemId}::${variant}`;

// Fill `row.Blob` from the filesystem backend for fs-backed rows that carry a
// Path but no inline Blob. Mutates and returns the row. Negative-cache markers
// (no Path, no Blob) and idb rows pass through untouched.
const rehydrateRow = async <T extends CachedThumbnail | undefined>(row: T): Promise<T> => {
    if (!row || row.Blob || !row.Path) return row;
    const ref = refForRow(row);
    if (!ref) return row;
    try {
        row.Blob = await backendForRef(ref).load(ref);
    } catch (err) {
        console.warn('[image-variants] thumbnail rehydrate failed', {
            error: (err as Error)?.message,
            itemId: row.ItemId,
            variant: row.Variant,
        });
    }
    return row;
};

const rehydrateRows = async (
    rows: (CachedThumbnail | undefined)[],
): Promise<(CachedThumbnail | undefined)[]> => Promise.all(rows.map((r) => rehydrateRow(r)));

// Persist thumbnail bytes through the active backend and return the row fields
// (Blob | Path/VolumeId/Backend) that encode where they landed.
export const persistThumbnailFields = async (
    itemId: string,
    variant: string,
    blob: Blob,
): Promise<Partial<CachedThumbnail>> => {
    const ref = await getActiveBackend().store('image', thumbBackendKey(itemId, variant), blob);
    return rowFieldsForRef(ref) as Partial<CachedThumbnail>;
};

// Reclaim a thumbnail row's backing file (no-op for idb rows / negative-cache
// markers).
export const reclaimThumbnailBytes = async (row: CachedThumbnail): Promise<void> => {
    const ref = refForRow(row);
    if (ref) await backendForRef(ref).remove(ref);
};

// ---------------------------------------------------------------------------
// Shared object-URL keep-alive (refcounted).
//
// Previously every mounted consumer called `URL.createObjectURL` for the
// SAME cached Blob, so scrolling a grid churned thousands of short-lived
// blob: URLs (each holding a live Blob reference until revoked). This map
// keeps ONE object URL per (item, variant) alive for the lifetime of its
// mounted consumers and revokes it only once the last consumer releases it.
//
// Keyed by the SAME `[itemId, variant]` compound key as the blob handoff
// (`variantKey`) — NOT by bare `itemId`. The variant cache (schema v11)
// stores a distinct pre-sized blob per surface bucket, so two surfaces of
// the same item rendering at different variants (e.g. an `itemCard` grid +
// the `fullScreen` now-playing cover) must each get their OWN object URL.
// Keying by bare itemId collapsed the second caller onto the first
// variant's task and handed back the wrong-variant URL (or, when the
// handoff slot for its variant was empty, `undefined` → the raw network
// URL, the >10s offline/mobile load). A consumer calls
// `acquireThumbnailUrl` (which resolves the blob, mints the URL once, and
// bumps the refcount) and `releaseThumbnailUrl(itemId, variant)` on
// unmount / input change. Legacy callers that still use `resolveThumbnail`
// directly keep their own per-call URL + revoke lifecycle and are
// unaffected.
interface SharedObjectUrl {
    refCount: number;
    url: string;
}
const sharedObjectUrls = new Map<string, SharedObjectUrl>();

// Zero-ref keep-alive. When the last consumer releases a shared URL we do
// NOT revoke immediately: scrolling a grid unmounts cells constantly, and an
// instant revoke meant scrolling BACK re-paid the async Dexie roundtrip (and
// flashed a skeleton) for art that was just on screen. Released entries
// linger for a grace period and can be re-adopted synchronously via
// `peekThumbnailUrl`; a cap bounds how much blob memory the lingering
// entries can hold (oldest evicted first).
const ZERO_REF_GRACE_MS = 90_000;
const ZERO_REF_SWEEP_MS = 30_000;
const ZERO_REF_CAP = 200;
// key -> released-at timestamp. Map insertion order doubles as the LRU.
const zeroRefSince = new Map<string, number>();
let zeroRefSweepTimer: null | ReturnType<typeof setTimeout> = null;

const revokeSharedEntry = (key: string): void => {
    const entry = sharedObjectUrls.get(key);
    sharedObjectUrls.delete(key);
    zeroRefSince.delete(key);
    if (!entry) return;
    try {
        URL.revokeObjectURL(entry.url);
    } catch {
        // Revoke can throw on already-revoked / invalid URLs in some
        // runtimes; nothing actionable, the entry is already gone.
    }
};

const scheduleZeroRefSweep = (): void => {
    if (zeroRefSweepTimer || zeroRefSince.size === 0) return;
    zeroRefSweepTimer = setTimeout(() => {
        zeroRefSweepTimer = null;
        const now = Date.now();
        for (const [key, since] of zeroRefSince) {
            if (now - since < ZERO_REF_GRACE_MS) continue;
            const entry = sharedObjectUrls.get(key);
            // Re-adopted entries are pruned from the queue on adoption, but
            // be defensive: never revoke a URL with live consumers.
            if (entry && entry.refCount > 0) {
                zeroRefSince.delete(key);
                continue;
            }
            revokeSharedEntry(key);
        }
        scheduleZeroRefSweep();
    }, ZERO_REF_SWEEP_MS);
};

// A consumer took a reference again — the entry is no longer eligible for
// the zero-ref sweep.
const cancelZeroRefEviction = (key: string): void => {
    zeroRefSince.delete(key);
};

// Enforce the zero-ref cap (oldest lingering entries revoked first) and make
// sure the sweep timer is armed. Shared by release + bulk preload.
const settleZeroRefQueue = (): void => {
    while (zeroRefSince.size > ZERO_REF_CAP) {
        const oldest = zeroRefSince.keys().next().value;
        if (oldest === undefined) break;
        revokeSharedEntry(oldest);
    }
    scheduleZeroRefSweep();
};

/**
 * Bulk-prime the shared URL cache for a page of items: ONE Dexie bulkGet for
 * every [itemId, variant] pair instead of N independent gets racing per cell.
 * Cache hits are minted as zero-ref shared URLs parked in the grace window,
 * so cells that mount afterwards adopt them SYNCHRONOUSLY via
 * `peekThumbnailUrl` — no per-cell IndexedDB roundtrip, no skeleton frame.
 * Misses and stale rows are left to the per-cell resolver (fetch/fallback).
 * Fire-and-forget; failures are swallowed (rendering never depends on this).
 */
export const preloadThumbnailUrls = async (
    itemIds: (null | string | undefined)[],
    variant: number | string,
): Promise<void> => {
    // Wait out the cold-start boot race (lifecycle opens the DB post-mount)
    // so the very first page write still gets its bulk prime. The loader
    // bounds how long it waits for us, so this can't delay row rendering.
    const db = isLocalCacheEnabled() ? await awaitActiveCacheDb() : getActiveCacheDb();
    if (!db) return;

    const resolvedVariant = normaliseVariant(variant);
    const wanted = [...new Set(itemIds.filter((id): id is string => Boolean(id)))].filter(
        (id) => !sharedObjectUrls.has(variantKey(id, resolvedVariant)),
    );
    if (wanted.length === 0) return;

    let rows: (CachedThumbnail | undefined)[];
    try {
        rows = await rehydrateRows(
            await db.thumbnails.bulkGet(
                wanted.map((id) => [id, resolvedVariant] as [string, string]),
            ),
        );
    } catch {
        return;
    }

    const now = Date.now();
    let minted = 0;
    for (const row of rows ?? []) {
        if (!row?.Blob || isStaleRow(row)) continue;
        const key = variantKey(row.ItemId, resolvedVariant);
        // A concurrent acquire may have landed while the bulkGet was in
        // flight — never clobber a live entry.
        if (sharedObjectUrls.has(key)) continue;
        const url = URL.createObjectURL(row.Blob);
        sharedObjectUrls.set(key, { refCount: 0, url });
        zeroRefSince.set(key, now);
        minted += 1;
    }
    if (minted > 0) {
        settleZeroRefQueue();
    }
};

// Test-only: drop every shared URL (revoking them) and clear the zero-ref
// queue + timer, so module-level state can't leak between tests.
export const __resetSharedThumbnailUrls = (): void => {
    for (const key of [...sharedObjectUrls.keys()]) {
        revokeSharedEntry(key);
    }
    zeroRefSince.clear();
    if (zeroRefSweepTimer) {
        clearTimeout(zeroRefSweepTimer);
        zeroRefSweepTimer = null;
    }
};

// In-flight dedup for `acquireThumbnailUrl`. Concurrent acquires for the
// same (item, variant) (the common case while a grid mounts a row of
// cards) share a single resolve + a single `URL.createObjectURL`, then
// each bumps the shared refcount once their promise settles. Without this,
// racing acquires could each mint their own URL and leak all but one.
// Keyed by `variantKey` so a different variant of the same item resolves
// on its own task and gets its own blob.
interface AcquireResult {
    // True when the miss was authoritative (404 / negative cache) — the
    // awaiters return the NO_ARTWORK_URL sentinel instead of the raw URL.
    noArtwork?: boolean;
    // The shared blob: URL when the resolve produced a cached blob, or
    // undefined on miss/failure (caller falls back to the raw URL).
    objectUrl: string | undefined;
}
const acquireInFlight = new Map<string, Promise<AcquireResult>>();

// Transient hand-off slot: `resolveThumbnail` run with `_wantBlob` stashes
// the resolved Blob here keyed by `[itemId, variant]` so the (deduped)
// acquire task can mint exactly one shared object URL. Drained immediately
// by the task.
const lastResolvedBlob = new Map<string, Blob>();
const takeResolvedBlob = (key: string): Blob | undefined => {
    const blob = lastResolvedBlob.get(key);
    if (blob) lastResolvedBlob.delete(key);
    return blob;
};

// Parallel hand-off for the authoritative no-artwork outcome (fresh 404 or
// negative-cache marker, with no substitute variant cached). Drained by the
// acquire task alongside the blob slot so the consumer can surface its
// placeholder instead of re-fetching the raw URL.
const lastResolvedNoArt = new Set<string>();
const takeResolvedNoArt = (key: string): boolean => lastResolvedNoArt.delete(key);

/**
 * Acquire a stable, shared `blob:` URL for an item's cached thumbnail at a
 * specific surface variant, resolving the blob through the cache pipeline
 * if needed. The returned URL is reference-counted: the caller MUST pair
 * every successful acquire (one that returns a `blob:` URL) with a
 * `releaseThumbnailUrl(itemId, variant)` carrying the SAME variant once it
 * is done displaying it. On a cache miss / failure the resolver's fallback
 * (the raw URL) is returned and is NOT refcounted — releasing it is a
 * no-op.
 *
 * All dedup / shared-URL bookkeeping is keyed by `[itemId, variant]`, so
 * two surfaces of the same item rendering at DIFFERENT variants each get
 * their own variant's blob (no cross-variant handoff).
 */
export const acquireThumbnailUrl = async (
    itemId: string,
    variant: number | string,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<string> => {
    const { url } = normaliseRequest(request);
    const resolvedVariant = normaliseVariant(variant);
    // Every map below — blob handoff, shared object URL, acquire dedup — is
    // keyed by this compound `[itemId, variant]` key so concurrent acquires
    // for the same item at different variants never collapse onto each
    // other's task or blob.
    const key = variantKey(itemId, resolvedVariant);

    // Fast path: a live shared URL already exists for this (item, variant).
    // Bump the refcount and hand the same string back — no new blob: URL
    // minted.
    const existing = sharedObjectUrls.get(key);
    if (existing) {
        existing.refCount += 1;
        cancelZeroRefEviction(key);
        return existing.url;
    }

    // Dedup concurrent acquires so the blob is resolved and the object URL
    // minted exactly once, regardless of how many cards mount at the same
    // tick. Each awaiter bumps the refcount below.
    let task = acquireInFlight.get(key);
    if (!task) {
        task = (async (): Promise<AcquireResult> => {
            try {
                await resolveThumbnail(itemId, resolvedVariant, request, {
                    ...options,
                    // Stash the raw Blob (if any) without minting a per-call
                    // URL; we mint exactly one shared URL here instead.
                    _wantBlob: true,
                });
                const blob = takeResolvedBlob(key);
                if (!blob) {
                    return { noArtwork: takeResolvedNoArt(key), objectUrl: undefined };
                }
                // Seed the shared entry with refCount 0; every awaiter
                // (including this one) bumps it to its final value after
                // the task settles.
                const objectUrl = URL.createObjectURL(blob);
                sharedObjectUrls.set(key, { refCount: 0, url: objectUrl });
                return { objectUrl };
            } finally {
                acquireInFlight.delete(key);
            }
        })();
        acquireInFlight.set(key, task);
    }

    const result = await task;
    if (!result.objectUrl) {
        // Authoritative no-artwork: surface the sentinel so the consumer
        // shows its placeholder instead of re-fetching the raw URL.
        if (result.noArtwork) return NO_ARTWORK_URL;
        // Cache miss / failure — fall back to the raw URL (un-refcounted).
        return url;
    }
    // The shared entry may already have been fully released + revoked
    // between the task settling and this awaiter resuming (rare: every
    // earlier awaiter mounted and unmounted before we got here). If so the
    // URL is dead; fall back to the raw URL and let a fresh acquire run.
    const entry = sharedObjectUrls.get(key);
    if (!entry || entry.url !== result.objectUrl) {
        return url;
    }
    entry.refCount += 1;
    return entry.url;
};

/**
 * Release a previously-acquired shared thumbnail URL. Decrements the
 * refcount for the given `[itemId, variant]` and revokes the underlying
 * object URL once the last consumer lets go. Callers MUST pass the SAME
 * variant they acquired with. Safe to call with a non-shared (raw
 * fallback) item/variant — it is a no-op when the pair isn't tracked.
 */
export const releaseThumbnailUrl = (
    itemId: string,
    variant?: number | string,
    url?: string,
): void => {
    // A release carrying the consumer's own URL may refer to an entry that an
    // upgrade has displaced from the keyed registry — settle it against the
    // orphan map so the refcount of the entry now under the key (the FRESH
    // blob) is never corrupted by a stale consumer's release.
    if (url && orphanedUrls.has(url)) {
        releaseOrphanedUrl(url);
        return;
    }
    const key = variantKey(itemId, normaliseVariant(variant));
    const entry = sharedObjectUrls.get(key);
    if (!entry) return;
    // URL-carrying release that matches neither the orphan map nor the keyed
    // entry: the consumer's blob was already fully settled (revoked) — a
    // keyed decrement would hit the WRONG (newer) entry.
    if (url && entry.url !== url) return;
    entry.refCount -= 1;
    if (entry.refCount <= 0) {
        entry.refCount = 0;
        // Keep the URL alive for the grace window so a scroll-back / route
        // return re-adopts it synchronously instead of re-paying the Dexie
        // roundtrip. The cap bounds lingering blob memory (oldest first).
        zeroRefSince.delete(key);
        zeroRefSince.set(key, Date.now());
        while (zeroRefSince.size > ZERO_REF_CAP) {
            const oldest = zeroRefSince.keys().next().value;
            if (oldest === undefined) break;
            revokeSharedEntry(oldest);
        }
        scheduleZeroRefSweep();
    }
};

/**
 * Synchronous fast path for already-resolved covers: if a live shared URL
 * exists for this (item, variant) — including one lingering in the zero-ref
 * grace window — take a reference and return it with NO async hop, so the
 * consumer can paint without ever entering a loading/skeleton state. Returns
 * undefined when nothing is held in memory (caller goes through the async
 * acquire). Every non-undefined return MUST be paired with
 * `releaseThumbnailUrl(itemId, variant)`.
 */
export const peekThumbnailUrl = (itemId: string, variant?: number | string): string | undefined => {
    const key = variantKey(itemId, normaliseVariant(variant));
    const entry = sharedObjectUrls.get(key);
    if (!entry) return undefined;
    entry.refCount += 1;
    cancelZeroRefEviction(key);
    return entry.url;
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

// ---------------------------------------------------------------------------
// Degraded-serve upgrade plumbing.
//
// Device evidence (2026-06-10): the fullscreen player asked for `fullScreen`
// while the connectivity signal said "unreachable"; the resolver served the
// only cached variant (a tiny `table` cover) and the surface settled on it
// FOREVER — `useNativeImage` keys on a stable request signature, so nothing
// ever re-resolved when connectivity recovered. The cache layer therefore
// remembers every degraded serve, regenerates the exact bucket when the
// network returns, announces the write (`feishin:thumbnail-upgraded`) so
// surfaces re-resolve, and invalidates the shared URL entry so the
// re-resolve mints the fresh blob instead of re-adopting the old one.
// ---------------------------------------------------------------------------

export const THUMBNAIL_UPGRADED_EVENT = 'feishin:thumbnail-upgraded';

interface DegradedServe {
    itemId: string;
    request: ImageRequest | string;
    variant: string;
}

// (item, variant) pairs a DISPLAY path served degraded (stale row,
// insufficient fallback, or an offline skip), with the request retained so
// the exact bucket can regenerate once the network allows. Cleared by the
// exact-bucket write (or its authoritative 404).
const degradedServes = new Map<string, DegradedServe>();

/**
 * Whether the most recent serve for this (item, variant) was DEGRADED (a
 * stale row or an under-sized substitute). Consumers use it at adoption time
 * to decide whether to arm the `feishin:thumbnail-upgraded` re-resolve.
 */
export const wasServedDegraded = (itemId: string, variant?: number | string): boolean =>
    degradedServes.has(variantKey(itemId, normaliseVariant(variant)));

const recordDegradedServe = (
    itemId: string,
    variant: string,
    request: ImageRequest | string,
): void => {
    degradedServes.set(variantKey(itemId, variant), { itemId, request, variant });
};

// Orphaned shared URLs: entries displaced from `sharedObjectUrls` by an
// upgrade while consumers still held references. Keyed by URL (the consumer
// passes its own URL on release) with the outstanding refcount; the last
// release schedules a grace-delayed revoke (the releasing consumer may still
// be PAINTING the URL while its replacement resolves).
const orphanedUrls = new Map<string, number>();

const releaseOrphanedUrl = (url: string): void => {
    const remaining = (orphanedUrls.get(url) ?? 1) - 1;
    if (remaining > 0) {
        orphanedUrls.set(url, remaining);
        return;
    }
    orphanedUrls.delete(url);
    setTimeout(() => {
        try {
            URL.revokeObjectURL(url);
        } catch {
            // Already revoked / invalid — nothing actionable.
        }
    }, ZERO_REF_GRACE_MS);
};

// A fresh exact-bucket row just landed: the in-memory shared entry (if any)
// now holds OUTDATED bytes. Displace it so the next peek/acquire mints from
// the fresh row; outstanding consumer references move to the orphan map.
const invalidateSharedThumbnail = (key: string): void => {
    const entry = sharedObjectUrls.get(key);
    if (!entry) return;
    sharedObjectUrls.delete(key);
    zeroRefSince.delete(key);
    if (entry.refCount <= 0) {
        try {
            URL.revokeObjectURL(entry.url);
        } catch {
            // Already revoked / invalid — nothing actionable.
        }
        return;
    }
    orphanedUrls.set(entry.url, entry.refCount);
};

// The exact bucket was just written (fresh fetch or background generate).
// Clear the degraded record, displace the now-outdated shared entry, and
// tell consumers to re-resolve.
const finishUpgrade = (itemId: string, variant: string): void => {
    const key = variantKey(itemId, variant);
    degradedServes.delete(key);
    invalidateSharedThumbnail(key);
    if (typeof window !== 'undefined') {
        window.dispatchEvent(
            new CustomEvent(THUMBNAIL_UPGRADED_EVENT, { detail: { itemId, variant } }),
        );
    }
};

// Degraded serves made while offline couldn't schedule their regenerate
// (the fetch was doomed). Flush them when connectivity returns.
subscribeIsOnline(() => {
    if (!getIsOnline() || degradedServes.size === 0) return;
    console.info('[image-variants] connectivity restored — regenerating degraded covers', {
        count: degradedServes.size,
    });
    for (const entry of degradedServes.values()) {
        imageVariantsInternals.scheduleVariantGenerate(entry.itemId, entry.variant, entry.request);
    }
});

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
    // The pixel size this resolve should fetch and record (`0` = original).
    // The thumbnail sweep passes the exact per-variant px it baked into the
    // URL; without it the resolver derives the px from the live config in
    // download mode and falls back to MAX_CACHE_SIZE otherwise.
    targetPx?: number;
}

// Map a response content-type to the stored `Format`. In download mode we
// keep the server bytes as-is; only WebP and JPEG are distinguished for
// accounting (anything non-WebP is recorded as 'jpeg', which is by far the
// most common cover format servers emit).
const formatFromContentType = (contentType: string): 'jpeg' | 'webp' =>
    contentType.toLowerCase().includes('webp') ? 'webp' : 'jpeg';

// Whether the local-cache subsystem is opted in. Gates the boot-race wait in
// `resolveThumbnail` — when disabled the DB never opens, so waiting for it
// would just delay the network fallback.
const isLocalCacheEnabled = (): boolean => {
    try {
        return useSettingsStore.getState().localCache?.enabled === true;
    } catch {
        return false;
    }
};

// Read the live variant config, falling back to the canonical defaults when
// the settings slice hasn't been seeded yet (fresh install / pre-migrate).
const getImageVariantsConfig = (): LocalCacheImageVariants => {
    try {
        return useSettingsStore.getState().localCache?.imageVariants ?? DEFAULT_IMAGE_VARIANTS;
    } catch {
        return DEFAULT_IMAGE_VARIANTS;
    }
};

// Fingerprint of the live variant config. Stamped on every blob row at write
// time (`__cfgHash`) so the resolver can detect rows produced under an older
// config (a px / format / quality / mode change) and regenerate them lazily.
const currentConfigHash = (): string => variantConfigHash(getImageVariantsConfig());

// A cached blob row is stale when the parameters that shaped ITS pixels
// (mode / format / quality / its own variant px) no longer match the live
// config. Compared field-wise via `isRowHashStale`, NOT as a whole-hash
// string: a full-config compare invalidated every cached cover when an
// unrelated bit flipped (4cab184c7 toggled the DEFAULT fullScreen enabled
// flag and every pre-existing row went "stale" at once). Rows WITHOUT a
// stored hash (legacy / pre-staleness) are treated as fresh — regenerating
// every one on first access after an upgrade would stampede the network for
// no visible benefit.
const isStaleRow = (row: CachedThumbnail | undefined): boolean => {
    if (!row?.__cfgHash) return false;
    if (!row.Variant) return row.__cfgHash !== currentConfigHash();
    return isRowHashStale(row.__cfgHash, row.Variant, getImageVariantsConfig());
};

// The px a resolve should fetch + record for `resolvedVariant`. An explicit
// `options.targetPx` (the sweep) wins; in download mode the lazy path derives
// the per-variant px from the live config so an 80px table bucket isn't
// fetched and stored at 1024px; everything else keeps the historical
// MAX_CACHE_SIZE behaviour (downscale mode fetches one large source).
const resolveTargetPx = (resolvedVariant: string, options?: ResolveThumbnailOptions): number => {
    if (typeof options?.targetPx === 'number') return options.targetPx;
    const cfg = getImageVariantsConfig();
    if (cfg.mode === 'download') {
        const px = cfg.variants[resolvedVariant as keyof typeof cfg.variants]?.px;
        if (typeof px === 'number') return px;
    }
    return MAX_CACHE_SIZE;
};

// Debounce window for background variant generation kicked off by a
// nearest-larger fallback hit. A list cell that shows a slightly-too-big
// cover schedules the exact-size variant once; rapid re-renders / re-scrolls
// for the same (item, variant) collapse into a single pending generate.
const GENERATE_DEBOUNCE_MS = 750;
const pendingGenerate = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Schedule a background generate of the EXACT requested variant after a
 * nearest-larger fallback served a substitute. Debounced per (item, variant)
 * so scrolling doesn't queue redundant fetches. The generate re-enters
 * `resolveThumbnail` with `_skipBlobUrl` (no object URL minted) so the row is
 * persisted for the next render without touching the URL registry.
 *
 * Routed through `imageVariantsInternals` at the call site so tests can spy
 * on it without firing a real network request.
 */
export const scheduleVariantGenerate = (
    itemId: string,
    variant: string,
    request: ImageRequest | string,
): void => {
    const key = variantKey(itemId, variant);
    const existing = pendingGenerate.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
        pendingGenerate.delete(key);
        console.info('[image-variants] background generate (fallback)', { itemId, variant });
        void resolveThumbnail(itemId, variant, request, { _skipBlobUrl: true });
    }, GENERATE_DEBOUNCE_MS);
    pendingGenerate.set(key, timer);
};

// Indirection holder so internal callers (the resolver's fallback path) and
// test spies reference the SAME function binding. `vi.spyOn(internals, ...)`
// then intercepts the internal call (ESM live bindings would not).
export const imageVariantsInternals = {
    scheduleVariantGenerate,
};

// `px === 0` rows are originals — treat as infinitely large for the
// sufficiency comparison (mirrors variant-config's ordering rule).
const effectivePx = (px: number): number => (px === 0 ? Number.POSITIVE_INFINITY : px);

interface FallbackPick {
    blob: Blob;
    // True when the picked row was produced under an older variant config.
    // The cache-first paint path refuses stale picks while ONLINE (the
    // staleness mechanic exists so config changes regenerate covers); when
    // offline a stale cover still beats a broken image.
    stale: boolean;
    // True when the served substitute is at least as large as the requested
    // variant (no upscaling) — the cache-first paint path serves these even
    // while online. Under-sized substitutes (`false`) are only served when
    // the network can't be trusted to do better.
    sufficient: boolean;
}

/**
 * On an exact-variant miss, look up the other variants already cached for
 * this item and return the nearest-larger one's blob so the surface renders
 * immediately instead of blocking on the raw URL. When a substitute is
 * served while online, schedule a debounced background generate of the exact
 * requested variant (offline it would just burn a doomed fetch). Returns
 * `undefined` when nothing usable is cached (caller falls back to the
 * network / raw URL).
 */

/**
 * Cache-ONLY: the best cached thumbnail for an item as a `data:` URL, or
 * null when nothing is cached. Built for consumers that hand the image to
 * NATIVE code (the Android media-notification plugin downloads artwork URLs
 * natively — a remote URL crashes the app offline, and blob:/object URLs are
 * renderer-only). Never touches the network. Prefers the largest variant
 * that stays under a transfer-friendly cap (base64 over the plugin bridge),
 * falling back to the smallest cached one for oversized originals.
 */
export const getCachedThumbnailDataUrl = async (itemId: string): Promise<null | string> => {
    const MAX_PREFERRED_BYTES = 500_000;
    const db = getActiveCacheDb();
    if (!db) return null;
    try {
        const rows = await rehydrateRows(
            await db.thumbnails.where('ItemId').equals(itemId).toArray(),
        );
        let bestUnderCap: Blob | undefined;
        let bestUnderCapSize = -1;
        let smallest: Blob | undefined;
        let smallestSize = Number.POSITIVE_INFINITY;
        for (const row of rows) {
            if (!row?.Blob) continue;
            const size = typeof row.Size === 'number' ? row.Size : row.Blob.size;
            if (size <= MAX_PREFERRED_BYTES && size > bestUnderCapSize) {
                bestUnderCap = row.Blob;
                bestUnderCapSize = size;
            }
            if (size < smallestSize) {
                smallest = row.Blob;
                smallestSize = size;
            }
        }
        const blob = bestUnderCap ?? smallest;
        if (!blob) return null;
        return await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    } catch {
        return null;
    }
};

const resolveFallbackPick = async (
    itemId: string,
    requestedVariant: string,
    request: ImageRequest | string,
): Promise<FallbackPick | undefined> => {
    const db = getActiveCacheDb();
    if (!db) return undefined;
    try {
        const rows = await rehydrateRows(
            await db.thumbnails.where('ItemId').equals(itemId).toArray(),
        );
        const cached: Record<string, number> = {};
        const blobByVariant = new Map<string, Blob>();
        const staleByVariant = new Map<string, boolean>();
        for (const row of rows) {
            if (row?.Blob && row.Variant) {
                cached[row.Variant] = typeof row.Size === 'number' ? row.Size : 0;
                blobByVariant.set(row.Variant, row.Blob);
                staleByVariant.set(row.Variant, isStaleRow(row));
            }
        }
        if (blobByVariant.size === 0) return undefined;

        const cfg = getImageVariantsConfig();
        const pick = nearestLargerVariant(requestedVariant as VariantName, cached, cfg);
        if (!pick) return undefined;
        const blob = blobByVariant.get(pick);
        if (!blob) return undefined;

        const requestedPx = effectivePx(
            cfg.variants[requestedVariant as VariantName]?.px ?? MAX_CACHE_SIZE,
        );
        const sufficient = effectivePx(cached[pick] ?? 0) >= requestedPx;
        const stale = staleByVariant.get(pick) ?? false;

        console.info('[image-variants] fallback served nearest-larger variant', {
            itemId,
            requested: requestedVariant,
            served: pick,
            stale,
            sufficient,
        });
        // An under-sized or stale substitute is a DEGRADED serve — remember
        // it so the exact bucket regenerates (now, or on reconnect when
        // offline) and the surface gets the upgrade event.
        if (!sufficient || stale) {
            recordDegradedServe(itemId, requestedVariant, request);
        }
        // Kick off the exact-size variant in the background (debounced) so
        // the substitute is replaced by the real bucket on the next render.
        if (getIsOnline()) {
            imageVariantsInternals.scheduleVariantGenerate(itemId, requestedVariant, request);
        }
        return { blob, stale, sufficient };
    } catch (err) {
        console.warn('[image-variants] fallback lookup failed', {
            error: (err as Error)?.message ?? String(err),
            itemId,
            variant: requestedVariant,
        });
        return undefined;
    }
};

// Blob-only view of `resolveFallbackPick` for the post-failure paths that
// serve ANY cached substitute (the network already had its chance).
const resolveFallbackBlob = async (
    itemId: string,
    requestedVariant: string,
    request: ImageRequest | string,
): Promise<Blob | undefined> => {
    const pick = await resolveFallbackPick(itemId, requestedVariant, request);
    return pick?.blob;
};

/**
 * Resolve a thumbnail to a `blob:` URL backed by the local cache. Accepts
 * either a bare URL (legacy callers) or a full `ImageRequest` so the
 * Authorization header can ride along — on Capacitor / Android there are
 * no cookies, so without the header every Jellyfin image fetch 401s and
 * the Dexie table never gets populated.
 *
 * `variant` is the surface bucket (`table`, `itemCard`, `sidebar`, `header`,
 * `fullScreen`) the caller is rendering. Every Dexie read/write is keyed on
 * the compound `[itemId, variant]` (schema v11), so each surface holds its
 * own pre-sized cover, and in-flight dedup is per-variant — two cards
 * wanting the same bucket share one fetch while a different bucket of the
 * same item resolves independently. Legacy callers that still pass a numeric
 * display size collapse to the `fullScreen` (original) variant. Falls back to
 * the original URL whenever the cache is unavailable or any step fails.
 */
export const resolveThumbnail = async (
    itemId: string,
    variant: number | string,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<string> => {
    const { credentials, headers, url } = normaliseRequest(request);
    // Display resolves briefly wait out the boot race: on a cold start the
    // lifecycle opens the DB in a post-mount effect, so the first wave of
    // covers used to see "no active DB" and fall straight to the network
    // even with everything cached. Only wait when the subsystem is actually
    // enabled (otherwise the DB never opens and every cover would stall the
    // full timeout). Sweep callers (`_skipBlobUrl`) only run once the
    // lifecycle is up, so they keep the synchronous check.
    const db =
        options?._skipBlobUrl || !isLocalCacheEnabled()
            ? getActiveCacheDb()
            : await awaitActiveCacheDb();
    if (!db) return url;

    const resolvedVariant = normaliseVariant(variant);
    const dbKey: [string, string] = [itemId, resolvedVariant];
    const dedupKey = variantKey(itemId, resolvedVariant);

    const signal = options?.signal;
    if (signal?.aborted) return url;

    const wantsDisplayBlob = !options?._skipBlobUrl;

    const existing = inFlight.get(dedupKey);
    if (existing) {
        const result = await existing;
        if (result.blob) {
            // Honor the caller's blob-delivery mode here too. Previously a
            // `_wantBlob` acquire (or a `_skipBlobUrl` sweep/generate call)
            // that collided with an in-flight task for the same (item,
            // variant) minted an object URL that nobody adopted — the
            // acquire path then fell back to the RAW network URL while the
            // orphan URL pinned the Blob in the registry forever.
            if (options?._wantBlob) {
                lastResolvedBlob.set(dedupKey, result.blob);
                return url;
            }
            if (options?._skipBlobUrl) return url;
            return URL.createObjectURL(result.blob);
        }
        // Exact miss for a render path — try the nearest-larger cached variant
        // before giving up to the raw URL.
        if (wantsDisplayBlob) {
            const fallback = await resolveFallbackBlob(itemId, resolvedVariant, request);
            if (fallback) {
                if (options?._wantBlob) {
                    lastResolvedBlob.set(dedupKey, fallback);
                    return url;
                }
                return URL.createObjectURL(fallback);
            }
            if (result.noArtwork) {
                if (options?._wantBlob) {
                    lastResolvedNoArt.add(dedupKey);
                    return url;
                }
                return NO_ARTWORK_URL;
            }
        }
        return url;
    }

    const gated = wantsDisplayBlob;
    const task = (async (): Promise<ResolverResult> => {
        // Display-path resolves wait for a concurrency slot; the sweep
        // (_skipBlobUrl) bypasses the gate (it has its own worker pool).
        if (gated) await acquireResolveSlot();
        try {
            if (signal?.aborted) return { blob: undefined, bytes: 0 };
            const row = await rehydrateRow(await db.thumbnails.get(dbKey));
            // Early-attempt diagnostic — logs what the resolver is
            // being asked to look up and whether the cache hit.
            // Bounded so it doesn't spam.
            if (lookupAttempts < LOOKUP_LOG_LIMIT) {
                lookupAttempts += 1;
                console.info('[image-variants] resolver lookup', {
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
                    variant: resolvedVariant,
                });
            }
            if (row) {
                if (row.Blob && isStaleRow(row)) {
                    if (wantsDisplayBlob) {
                        // Serve-stale-while-revalidate: a stale-config row is
                        // still a perfectly good cover. Paint it INSTANTLY and
                        // regenerate the exact bucket in the background —
                        // dropping the hit to block on a refetch made every
                        // page visit visibly re-load its covers against a slow
                        // server.
                        console.info('[image-variants] stale variant served, regenerating', {
                            itemId,
                            variant: resolvedVariant,
                        });
                        recordDegradedServe(itemId, resolvedVariant, request);
                        if (getIsOnline()) {
                            imageVariantsInternals.scheduleVariantGenerate(
                                itemId,
                                resolvedVariant,
                                request,
                            );
                        }
                        recordStat('blobHit');
                        return { blob: row.Blob, bytes: 0 };
                    }
                    // Sweep / background-generate path: refetch in-line — this
                    // IS the regeneration that replaces the stale row.
                    console.info('[image-variants] stale variant, regenerating', {
                        itemId,
                        variant: resolvedVariant,
                    });
                } else if (row.Blob) {
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
                        void db.thumbnails.update(dbKey, { LastUsed: now });
                    }
                    hitCount += 1;
                    recordStat('blobHit');
                    if (hitCount % HIT_LOG_SAMPLE === 0) {
                        console.info('[image-variants] thumbnail hits', { total: hitCount });
                    }
                    return { blob: row.Blob, bytes: 0 };
                }
                const missAt = row.MissAt ?? 0;
                const nowMs = Date.now();
                if (nowMs - missAt < MISS_TTL_MS) {
                    // CONTRADICTION GUARD: a 404 marker for THIS variant while
                    // a SIBLING variant of the same item holds a real blob is
                    // bogus (flaky proxy / load-shed 404 during a bad server
                    // window) — the artwork demonstrably exists. Bust the
                    // marker and refetch instead of feeding the surface the
                    // no-artwork placeholder for the 7-day marker TTL
                    // (device, 2026-06-10: fullscreen player showed the
                    // placeholder while the miniplayer had the cover).
                    const sibling = await db.thumbnails
                        .where('ItemId')
                        .equals(itemId)
                        .toArray()
                        // A real cached cover is either an inline Blob (idb) or
                        // a file Path (fs backend); negative-cache markers have
                        // neither.
                        .then((rows) => rows.some((r) => Boolean(r?.Blob || r?.Path)))
                        .catch(() => false);
                    if (sibling) {
                        console.info('[image-variants] 404 marker contradicted by sibling blob', {
                            itemId,
                            variant: resolvedVariant,
                        });
                        // Fall through to refetch (success replaces the
                        // marker; a genuine re-404 rewrites it).
                    } else {
                        if (nowMs - (row.LastUsed ?? 0) > 3_600_000) {
                            void db.thumbnails.update(dbKey, { LastUsed: nowMs });
                        }
                        recordStat('missMarkerHit');
                        return { blob: undefined, bytes: 0, noArtwork: true };
                    }
                }
                // Stale miss (or contradicted marker): fall through to refetch.
            }

            // Cache-first paint path. The exact bucket missed, but a cover
            // that is already in Dexie beats a network round-trip:
            //  - a larger-or-equal cached variant is served unconditionally
            //    (no quality loss, zero network in the paint path);
            //  - while offline/unreachable, ANY cached variant is served
            //    (an upscaled cover beats a hung fetch or a broken image).
            // Sweep / background-generate resolves (`_skipBlobUrl`) are
            // excluded — their entire job is to persist the exact bucket.
            if (wantsDisplayBlob) {
                const fallback = await resolveFallbackPick(itemId, resolvedVariant, request);
                // Online, a pick must be both large enough AND produced under
                // the live config; offline anything beats a doomed fetch.
                if (fallback && ((fallback.sufficient && !fallback.stale) || !getIsOnline())) {
                    recordStat('blobHit');
                    return { blob: fallback.blob, bytes: 0 };
                }
                // Nothing cached and the server is known-unreachable: don't
                // start a doomed fetch (on a hung LAN host each attempt
                // burns the full 20s timeout). The caller falls back to the
                // raw URL and the <img> errors out to the unloader quickly.
                // (When `fallback` exists here it was insufficient AND we're
                // online — the first branch handled every offline+fallback
                // combination.) Recorded as degraded so the bucket fetches
                // once connectivity returns and the surface repaints.
                if (!getIsOnline()) {
                    recordDegradedServe(itemId, resolvedVariant, request);
                    return { blob: undefined, bytes: 0 };
                }
            }

            const targetPx = resolveTargetPx(resolvedVariant, options);
            const fetchUrl = rewriteUrlToVariantSize(url, targetPx);
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
                    consecutiveImageTimeouts += 1;
                    console.warn('[image-variants] thumbnail fetch timed out', {
                        consecutiveTimeouts: consecutiveImageTimeouts,
                        itemId,
                        variant: resolvedVariant,
                    });
                    // A 20s stall is a transport-level hang (LAN host gone,
                    // VPN dropped), not an HTTP error. But ONE slow cover isn't
                    // proof the server is gone — only flip the combined
                    // connectivity signal after a streak of consecutive
                    // timeouts with no intervening response. Below the
                    // threshold we just fail this item and move on; the streak
                    // resets the moment any cover responds.
                    if (consecutiveImageTimeouts >= IMAGE_TIMEOUT_LATCH_THRESHOLD) {
                        markServerUnreachable();
                    }
                    recordStat('failed');
                    return { blob: undefined, bytes: 0 };
                }
                if ((err as Error)?.name === 'AbortError') {
                    return { blob: undefined, bytes: 0 };
                }
                console.warn('[image-variants] thumbnail fetch threw', {
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
            // Any HTTP response (even an error status) means the server is
            // reachable again — image stalls flip the shared connectivity
            // signal to "unreachable", so image SUCCESSES must flip it back
            // (axios traffic alone may be sparse while covers sweep). A
            // response also breaks any timeout streak.
            consecutiveImageTimeouts = 0;
            markServerReachable();
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
                                Size: targetPx,
                                Variant: resolvedVariant,
                            });
                            recordStat('missWrite');
                            // Authoritatively no artwork — the degraded serve
                            // is as upgraded as it will ever get.
                            degradedServes.delete(variantKey(itemId, resolvedVariant));
                        } catch (err) {
                            console.warn('[image-variants] thumbnail miss-write failed', {
                                error: (err as Error)?.message,
                                itemId,
                                variant: resolvedVariant,
                            });
                        }
                    }
                } else {
                    console.warn('[image-variants] thumbnail HTTP error', {
                        hasAuthHeader: Boolean(headers?.Authorization),
                        itemId,
                        status: res.status,
                    });
                    recordStat('failed');
                }
                return { blob: undefined, bytes: 0, noArtwork: res.status === 404 };
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
                    requestedSize: targetPx,
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

            const blobFields = await persistThumbnailFields(itemId, resolvedVariant, blob);
            await db.thumbnails.put({
                __cachedAt: Date.now(),
                __cfgHash: currentConfigHash(),
                // Always present (idb backend overrides via blobFields; fs leaves
                // it undefined and sets Path). CachedThumbnail requires the key.
                Blob: undefined,
                ByteSize: blob.size,
                Etag: res.headers.get('etag') ?? undefined,
                Format: formatFromContentType(contentType),
                ItemId: itemId,
                LastUsed: Date.now(),
                MissAt: undefined,
                Size: targetPx,
                Variant: resolvedVariant,
                ...blobFields,
            });
            emitWritten();
            finishUpgrade(itemId, resolvedVariant);
            missCount += 1;
            recordStat('fetched', blob.size);
            console.info('[image-variants] thumbnail fetched', {
                bytes: blob.size,
                itemId,
                missesSoFar: missCount,
                variant: resolvedVariant,
            });
            return { blob, bytes: blob.size };
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return { blob: undefined, bytes: 0 };
            console.warn('[image-variants] thumbnail fetch failed', {
                error: (err as Error)?.message ?? String(err),
                errorName: (err as Error)?.name,
                itemId,
                variant: resolvedVariant,
            });
            recordStat('failed');
            return { blob: undefined, bytes: 0 };
        } finally {
            if (gated) releaseResolveSlot();
            inFlight.delete(dedupKey);
        }
    })();

    inFlight.set(dedupKey, task);
    const result = await task;

    // On an exact-variant miss for a render path, serve the nearest-larger
    // cached variant (and schedule the exact one in the background) so the
    // surface never blocks on / re-fetches the full-res original mid-scroll.
    // The sweep / background-generate path (`_skipBlobUrl`) is excluded to
    // avoid pointless fallback work and re-scheduling loops.
    let displayBlob = result.blob;
    if (!displayBlob && wantsDisplayBlob) {
        displayBlob = await resolveFallbackBlob(itemId, resolvedVariant, request);
    }

    if (options?._wantBlob) {
        // Hand the Blob off to acquireThumbnailUrl, which mints exactly
        // one shared object URL. Return the raw URL as a sentinel — the
        // acquire path keys off the stashed Blob, not this return value.
        if (displayBlob) lastResolvedBlob.set(dedupKey, displayBlob);
        else if (result.noArtwork) lastResolvedNoArt.add(dedupKey);
        return url;
    }
    if (options?._skipBlobUrl) return url;
    if (displayBlob) return URL.createObjectURL(displayBlob);
    // Authoritative no-artwork (404 / negative cache) with nothing usable
    // cached: tell the consumer NOT to retry the raw URL.
    if (result.noArtwork) return NO_ARTWORK_URL;
    return url;
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
    variant: number | string,
    request: ImageRequest | string,
    options?: ResolveThumbnailOptions,
): Promise<{ bytes: number; noArtwork?: boolean; url: string }> => {
    const { credentials, headers, url } = normaliseRequest(request);
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0, url };

    const resolvedVariant = normaliseVariant(variant);
    const dedupKey = variantKey(itemId, resolvedVariant);

    const signal = options?.signal;
    if (signal?.aborted) return { bytes: 0, url };

    // Share the in-flight task with `resolveThumbnail`. If the task
    // hasn't started yet, kick it off; both APIs end up awaiting the
    // same per-variant inFlight entry. Reading only `result.bytes` means we
    // never createObjectURL on this path, so the sweep can no longer
    // leak per-item blob URLs.
    if (!inFlight.has(dedupKey)) {
        // Pass _skipBlobUrl so resolveThumbnail does not call
        // URL.createObjectURL — the returned string is discarded but the
        // browser URL registry would hold the Blob indefinitely, causing
        // progressive heap growth during the sweep (hundreds of MB after
        // ~1k thumbnails → GC pressure → throughput collapses to <0.1/s).
        void resolveThumbnail(
            itemId,
            resolvedVariant,
            { cacheKey: url, credentials, headers, url },
            { ...options, _skipBlobUrl: true },
        );
    }
    const task = inFlight.get(dedupKey);
    if (!task) return { bytes: 0, url };
    const result = await task;
    // Surface `noArtwork` so the sweep can tell an AUTHORITATIVE miss (fresh
    // 404 / negative-cache marker — safe to mark the unit done) apart from a
    // TRANSIENT failure (timeout / network drop — `bytes: 0` with no
    // `noArtwork`), which must be retried rather than recorded as a permanent
    // skip. Without this both look identical (`bytes: 0`) and a network blip
    // mid-sweep silently strands items as "no artwork" for the rest of the run.
    return { bytes: result.bytes, noArtwork: result.noArtwork, url };
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
// The probe is the non-acquiring membership check used by `<BaseImage>` to
// skip its debounce/viewport gating when the cover would paint synchronously.
const hasThumbnailUrl = (itemId: string, variant?: number | string): boolean =>
    sharedObjectUrls.has(variantKey(itemId, normaliseVariant(variant)));

registerThumbnailUrlCache(
    acquireThumbnailUrl,
    releaseThumbnailUrl,
    peekThumbnailUrl,
    hasThumbnailUrl,
);

// Degraded-serve probe: lets `useNativeImage` arm its upgrade re-resolve
// when the blob it just adopted was a stale/under-sized substitute.
registerThumbnailDegradedProbe(wasServedDegraded);
