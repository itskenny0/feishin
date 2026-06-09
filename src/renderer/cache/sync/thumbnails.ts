// Thumbnail pre-cache sweep (schema v11 — multi-resolution variant cache).
// Iterates every album / artist / playlist row in Dexie and fills the
// `[ItemId+Variant]` table with one pre-sized cover per enabled surface
// bucket.
//
// Two generation modes (the global `localCache.imageVariants.mode` switch):
//  - download:  one server request per (item × enabled variant) at that
//               variant's px (`rewriteUrlToVariantSize`). The sweep fans out
//               to one work unit per (item, variant).
//  - downscale: one server request per item at the largest enabled px, then
//               the worker downscales locally to every enabled variant
//               (`downscaleToVariants`). The sweep keeps one work unit per
//               item but writes N rows.
//
// The sweep is opt-in: zero enabled variants (`enabledVariants(cfg).length
// === 0`) means "no pre-cache" — the lazy `<BaseImage>` path still fills the
// table incidentally as the user browses.

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';
import type { ServerListItem } from '/@/shared/types/domain-types';

import { api } from '/@/renderer/api';
import { getActiveCacheDb } from '/@/renderer/cache/db';
import { evict } from '/@/renderer/cache/eviction';
import {
    MAX_CACHE_SIZE,
    resolveThumbnailWithBytes,
    rewriteUrlToVariantSize,
} from '/@/renderer/cache/images';
import { useCacheStore } from '/@/renderer/cache/store';
import {
    type EnabledVariant,
    enabledVariants,
    variantConfigHash,
} from '/@/renderer/cache/variant-config';
import { downscaleVariantsPooled } from '/@/renderer/cache/variant-downscale-pool';
import { DEFAULT_IMAGE_VARIANTS, useSettingsStore } from '/@/renderer/store';
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

/**
 * One unit of sweep work.
 *
 *  - download mode:  a single (item, variant) pair fetched at `px` directly
 *    from the server. The queue holds one of these per enabled variant, so a
 *    single album expands to N units.
 *  - downscale mode: a single item fetched ONCE at `px` (= the largest
 *    enabled px), then downscaled into every variant listed in
 *    `downscaleVariants`. The queue holds one unit per item.
 */
interface PendingThumbnail {
    // download: the variants to produce from the single source fetch. Always
    // present in downscale mode, absent in download mode.
    downscaleVariants?: EnabledVariant[];
    itemId: string;
    itemType: LibraryItem;
    kind: EntityKind;
    // The upstream px to request for THIS unit (download: the variant px;
    // downscale: the largest enabled px so every smaller variant can be
    // produced without upscaling).
    px: number;
    // The surface bucket this unit writes (download mode only — downscale
    // writes every bucket in `downscaleVariants`).
    variant?: string;
}

/**
 * Collect the sweep work units, fanned out according to the variant config.
 *
 * We attempt every row that has an `id` — `imageId` is unreliable on some
 * servers (Jellyfin omits it from list endpoints even when the entity has
 * artwork accessible via the per-item endpoint), so we let the server return
 * 404 rather than pre-filtering.
 *
 * Fan-out:
 *  - download:  one unit per (item × enabled variant), each carrying that
 *    variant's name + target px.
 *  - downscale: one unit per item, carrying the largest enabled px (so the
 *    single fetch is large enough for every variant) and the full enabled
 *    list for local downscaling.
 *
 * Exported for unit testing the fan-out shape.
 */
export const collectPending = async (cfg: LocalCacheImageVariants): Promise<PendingThumbnail[]> => {
    const db = getActiveCacheDb();
    if (!db) return [];

    const enabled = enabledVariants(cfg);
    if (enabled.length === 0) return [];

    // The sweep honors whatever variants are enabled. Pre-caching the
    // full-resolution original (`px === 0`, the fullScreen variant) is OPT-IN
    // and OFF by default — originals are multi-megabyte and a full sweep of
    // them takes hours. When fullScreen is disabled (the default) originals
    // load lazily on demand via `resolveThumbnail`; when a user enables it the
    // sweep pre-caches them too.
    //
    // Downscale source fetch must be at least the largest enabled variant so
    // nothing upscales. `enabled` is sorted ascending with original (px 0)
    // sorting last, so the final entry is the largest (original, if enabled).
    const largestPx = enabled[enabled.length - 1].px;

    const items: { itemId: string; itemType: LibraryItem; kind: EntityKind }[] = [];

    // Only the primary key (Id) is needed here, so read keys instead of whole
    // rows — `toArray()` structured-clones every full Payload into memory (a
    // multi-MB allocation + GC spike on a populated library) just to read .Id.
    const albumIds = (await db.albums.toCollection().primaryKeys()) as string[];
    for (const id of albumIds) {
        if (!id) continue;
        items.push({ itemId: id, itemType: LibraryItem.ALBUM, kind: 'album' });
    }

    const artistIds = (await db.artists.toCollection().primaryKeys()) as string[];
    for (const id of artistIds) {
        if (!id) continue;
        items.push({ itemId: id, itemType: LibraryItem.ALBUM_ARTIST, kind: 'artist' });
    }

    const playlistIds = (await db.playlists.toCollection().primaryKeys()) as string[];
    for (const id of playlistIds) {
        if (!id) continue;
        items.push({ itemId: id, itemType: LibraryItem.PLAYLIST, kind: 'playlist' });
    }

    const out: PendingThumbnail[] = [];
    if (cfg.mode === 'download') {
        // One unit per (item × enabled variant).
        for (const item of items) {
            for (const v of enabled) {
                out.push({ ...item, px: v.px, variant: v.variant });
            }
        }
    } else {
        // downscale: one unit per item; the worker fetches once at the largest
        // enabled px and produces every enabled variant locally.
        for (const item of items) {
            out.push({ ...item, downscaleVariants: enabled, px: largestPx });
        }
    }

    return out;
};

// Pre-built request templates by itemType. The sweep iterates 18k+
// items; rebuilding the full ImageRequest each iteration (which reads
// the auth store, runs URL serialization, etc.) is wasted work since
// only the ID varies. We build one template per itemType once at sweep
// init and string-replace the ID per fetch.
interface RequestTemplate {
    credentials?: RequestCredentials;
    headers?: Record<string, string>;
    urlAfter: string;
    urlBefore: string;
}

const ID_PLACEHOLDER = '__FEISHIN_ID_PLACEHOLDER__';

const buildRequestTemplate = (
    serverId: string,
    itemType: LibraryItem,
): RequestTemplate | undefined => {
    const request = api.controller.getImageRequest({
        apiClientProps: { serverId },
        query: { id: ID_PLACEHOLDER, itemType, size: MAX_CACHE_SIZE },
    });
    if (!request) return undefined;
    const idx = request.url.indexOf(ID_PLACEHOLDER);
    if (idx < 0) return undefined;
    return {
        credentials: request.credentials,
        headers: request.headers,
        urlAfter: request.url.slice(idx + ID_PLACEHOLDER.length),
        urlBefore: request.url.slice(0, idx),
    };
};

// Per-item-type request templates, looked up by itemType. Built once per
// sweep so the workers don't re-read the auth store / re-serialize URLs.
type TemplateMap = Partial<Record<LibraryItem, RequestTemplate>>;

const buildTemplates = (serverId: string): TemplateMap => {
    const templates: TemplateMap = {};
    for (const lt of [LibraryItem.ALBUM, LibraryItem.ALBUM_ARTIST, LibraryItem.PLAYLIST]) {
        const tpl = buildRequestTemplate(serverId, lt);
        if (tpl) templates[lt] = tpl;
    }
    return templates;
};

/**
 * Fetch + persist one DOWNLOAD-mode work unit: request the cover at the
 * variant's px directly from the server and store it under `[itemId, variant]`
 * via the shared resolver (which handles dedup, miss markers, and the write).
 */
const fetchDownloadUnit = async (
    pending: PendingThumbnail,
    template: RequestTemplate,
    signal: AbortSignal,
): Promise<{ bytes: number }> => {
    if (signal.aborted) return { bytes: 0 };
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0 };

    const variant = pending.variant ?? 'fullScreen';
    const baseUrl = template.urlBefore + pending.itemId + template.urlAfter;
    const url = rewriteUrlToVariantSize(baseUrl, pending.px);
    const request = {
        cacheKey: url,
        credentials: template.credentials,
        headers: template.headers,
        url,
    };

    const result = await resolveThumbnailWithBytes(pending.itemId, variant, request, {
        signal,
        // The per-variant px is already baked into `url`; without this the
        // resolver would rewrite it back to MAX_CACHE_SIZE and store every
        // variant at 1024px (with a lying `Size`).
        targetPx: pending.px,
    });
    return { bytes: result.bytes };
};

/**
 * Fetch + persist one DOWNSCALE-mode work unit: fetch the cover ONCE at the
 * largest enabled px, decode it, and write one re-encoded row per enabled
 * variant via `downscaleToVariants`. One network request, N Dexie rows.
 */
const fetchDownscaleUnit = async (
    pending: PendingThumbnail,
    template: RequestTemplate,
    cfg: LocalCacheImageVariants,
    signal: AbortSignal,
): Promise<{ bytes: number }> => {
    if (signal.aborted) return { bytes: 0 };
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0 };

    const variants = pending.downscaleVariants ?? [];
    if (variants.length === 0) return { bytes: 0 };

    const baseUrl = template.urlBefore + pending.itemId + template.urlAfter;
    const url = rewriteUrlToVariantSize(baseUrl, pending.px);

    // Manual timeout (mirrors the resolver) — AbortSignal.timeout/any aren't
    // universally available on older Android WebViews.
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, 20_000);
    const upstreamAbort = (): void => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', upstreamAbort);

    let srcBlob: Blob;
    try {
        const res = await fetch(url, {
            credentials: template.credentials,
            headers: template.headers,
            signal: controller.signal,
        });
        if (!res.ok) {
            // Persist a per-variant miss marker so the sweep doesn't re-attempt
            // a 404 every pass (mirrors the resolver's negative cache). Like
            // the resolver's markers these intentionally omit __cfgHash — a
            // 404 at one px is a 404 at every px, so a config change need not
            // retry them before MISS_TTL expiry.
            if (res.status === 404 && db === getActiveCacheDb()) {
                const now = Date.now();
                await Promise.all(
                    variants.map((v) =>
                        db.thumbnails
                            .put({
                                __cachedAt: now,
                                Blob: undefined,
                                ByteSize: 0,
                                Etag: undefined,
                                ItemId: pending.itemId,
                                LastUsed: now,
                                MissAt: now,
                                Size: v.px,
                                Variant: v.variant,
                            })
                            .catch(() => undefined),
                    ),
                );
            }
            return { bytes: 0 };
        }
        srcBlob = await res.blob();
    } catch (err) {
        if (timedOut) {
            console.warn('[image-variants] sweep: downscale source fetch timed out', {
                itemId: pending.itemId,
            });
        } else if ((err as Error)?.name !== 'AbortError') {
            console.warn('[image-variants] sweep: downscale source fetch failed', {
                error: (err as Error)?.message ?? String(err),
                itemId: pending.itemId,
            });
        }
        return { bytes: 0 };
    } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', upstreamAbort);
    }

    if (signal.aborted || db !== getActiveCacheDb()) return { bytes: 0 };

    let produced: Map<string, { blob: Blob; format: 'jpeg' | 'webp' }>;
    try {
        produced = await downscaleVariantsPooled(
            srcBlob,
            variants.map((v) => ({ px: v.px, variant: v.variant })),
            { format: cfg.format, quality: cfg.quality },
        );
    } catch (err) {
        console.warn('[image-variants] sweep: downscale failed', {
            error: (err as Error)?.message ?? String(err),
            itemId: pending.itemId,
        });
        return { bytes: 0 };
    }

    if (signal.aborted || db !== getActiveCacheDb()) return { bytes: 0 };

    let bytes = 0;
    const now = Date.now();
    // Stamp the config fingerprint like the lazy resolver does — without it
    // these rows are treated as permanently fresh and a px/quality/format
    // change never regenerates sweep-produced covers.
    const cfgHash = variantConfigHash(cfg);
    const variantPx = new Map<string, number>(variants.map((v) => [v.variant, v.px]));
    await Promise.all(
        [...produced.entries()].map(async ([variant, { blob, format }]) => {
            bytes += blob.size;
            try {
                await db.thumbnails.put({
                    __cachedAt: now,
                    __cfgHash: cfgHash,
                    Blob: blob,
                    ByteSize: blob.size,
                    Etag: undefined,
                    Format: format,
                    ItemId: pending.itemId,
                    LastUsed: now,
                    MissAt: undefined,
                    Size: variantPx.get(variant) ?? 0,
                    Variant: variant,
                });
            } catch (err) {
                console.warn('[image-variants] sweep: downscale write failed', {
                    error: (err as Error)?.message ?? String(err),
                    itemId: pending.itemId,
                    variant,
                });
            }
        }),
    );

    return { bytes };
};

// Test-only seam (mirrors images.ts's imageVariantsInternals): the sweep units
// are otherwise unreachable without standing up the whole sweep loop.
export const __thumbnailsSweepInternals = {
    fetchDownloadUnit,
    fetchDownscaleUnit,
};

/**
 * Run the thumbnail pre-cache sweep for the given server. No-op when
 * the user has explicitly opted out (`thumbnailSizes` empty).
 */
export const runThumbnailsSweep = async (
    args: { signal: AbortSignal },
    server: ServerListItem,
): Promise<void> => {
    const { signal } = args;
    const localCache = useSettingsStore.getState().localCache;
    const cfg: LocalCacheImageVariants = localCache?.imageVariants ?? DEFAULT_IMAGE_VARIANTS;
    // Opt-out: zero enabled variants = "no pre-cache" (replaces the vestigial
    // `thumbnailSizes` sentinel). The lazy `<BaseImage>` path still fills the
    // table incidentally as the user browses.
    const enabled = enabledVariants(cfg);
    if (enabled.length === 0) {
        console.info('[image-variants] sweep: no enabled variants, skipping');
        return;
    }

    const pending = await collectPending(cfg);
    const total = pending.length;
    if (total === 0) {
        console.info('[cache] thumbnails sweep: no items to pre-cache yet');
        return;
    }

    // The fan-out is what drives the progress denominator: in download mode
    // `total` is items × enabled-variants; in downscale mode it's one unit per
    // item (each producing every variant). Logged so the dashboard total is
    // explainable.
    console.info('[image-variants] sweep: ' + `${enabled.length} variants × items`, {
        mode: cfg.mode,
        variants: enabled.length,
        workUnits: total,
    });

    // Honour the user-tunable concurrency setting. Clamped to the
    // [MIN_CONCURRENCY, MAX_CONCURRENCY] range to keep typos / hostile
    // values from saturating the network or starving the worker.
    const configured = useSettingsStore.getState().localCache?.thumbnailConcurrency;
    const concurrency = Math.min(
        MAX_CONCURRENCY,
        Math.max(MIN_CONCURRENCY, configured ?? DEFAULT_CONCURRENCY),
    );

    console.info('[cache] thumbnails sweep: starting', {
        cacheSize: MAX_CACHE_SIZE,
        concurrency,
        items: total,
        serverId: server.id,
    });
    // Diagnostic banner: after a "Clear everything" the user expected
    // every item to need a real fetch. If something below this line
    // says skipImmediately > 0, the clear didn't actually wipe the
    // thumbnails table — or a stale row leaked through some other
    // path. Logged BEFORE workers start so it's easy to spot.
    console.info('[cache] thumbnails sweep: pre-flight', {
        queueSize: total,
    });

    const actions = useCacheStore.getState().actions;
    const startedAt = Date.now();
    let done = 0;
    let bytesDownloaded = 0;
    // Verbose-mode counters. Split between "fetched fresh" / "skipped
    // already cached" / "failed" so the final summary tells the user
    // which bucket actually consumed network time.
    let fetched = 0;
    let skipped = 0;
    let failed = 0;
    let lastAnomalyWarnAt = 0;

    // Pre-fetch every existing thumbnail row's `[ItemId, Variant]` key so the
    // worker pool can skip already-cached (item, variant) pairs without a Dexie
    // round-trip per unit. On a re-sync where the cache is mostly warm this
    // turns a crawl into a near-instant scan.
    //
    // Negative-cache markers (Blob === undefined) are honoured per-variant as
    // long as they're still fresh — the server already told us 404 for THAT
    // variant, no point re-asking on every sweep. Once a marker is older than
    // MISS_TTL_MS we let it through so the sweep retries (newly-added artwork
    // should eventually populate). The TTL matches `resolveThumbnail`.
    const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const db = getActiveCacheDb();
    // Keyed `${itemId}::${variant}` — one entry per cached (item, variant).
    const existingKeys = new Set<string>();
    const skipKey = (itemId: string, variant: string): string => `${itemId}::${variant}`;
    let staleMissCount = 0;
    let freshMissCount = 0;
    if (db) {
        try {
            // CRITICAL: do NOT call db.thumbnails.toArray() here — that would
            // pull every Blob into memory. Read just the compound primary keys
            // (skips the row store entirely), and separately read only the
            // small miss-marker rows to decide fresh vs stale.
            const [allKeys, missRows] = await Promise.all([
                db.thumbnails.toCollection().primaryKeys() as Promise<[string, string][]>,
                db.thumbnails.where('MissAt').above(0).toArray(),
            ]);
            const now = Date.now();
            // Stale miss markers, keyed per (item, variant) so a stale miss on
            // one variant doesn't force a re-fetch of an item's other variants.
            const staleMissKeys = new Set<string>();
            for (const row of missRows) {
                const missAt = row.MissAt ?? 0;
                if (now - missAt >= MISS_TTL_MS) {
                    staleMissKeys.add(skipKey(row.ItemId, row.Variant));
                    staleMissCount += 1;
                } else {
                    freshMissCount += 1;
                }
            }
            for (const key of allKeys) {
                // Dexie returns compound keys as `[ItemId, Variant]` tuples.
                if (!Array.isArray(key)) continue;
                const composite = skipKey(key[0], key[1]);
                if (!staleMissKeys.has(composite)) existingKeys.add(composite);
            }
            console.info('[cache] thumbnails sweep: prefetched existing keys', {
                count: existingKeys.size,
                freshMissCount,
                staleMissCount,
                totalRows: allKeys.length,
            });
        } catch (err) {
            console.warn('[cache] thumbnails sweep: prefetch failed', err);
        }
    }

    // Whether a work unit is already fully satisfied by cached rows. In
    // download mode that's a single (item, variant); in downscale mode the
    // unit produces every enabled variant, so it can only be skipped when ALL
    // of them are already cached.
    const isUnitCached = (unit: PendingThumbnail): boolean => {
        if (cfg.mode === 'download') {
            return existingKeys.has(skipKey(unit.itemId, unit.variant ?? 'fullScreen'));
        }
        const vs = unit.downscaleVariants ?? [];
        return vs.length > 0 && vs.every((v) => existingKeys.has(skipKey(unit.itemId, v.variant)));
    };

    // Mark a unit's variants cached after a successful fetch so a later unit
    // for the same item (or a re-scan) skips it.
    const markUnitCached = (unit: PendingThumbnail): void => {
        if (cfg.mode === 'download') {
            existingKeys.add(skipKey(unit.itemId, unit.variant ?? 'fullScreen'));
            return;
        }
        for (const v of unit.downscaleVariants ?? []) {
            existingKeys.add(skipKey(unit.itemId, v.variant));
        }
    };

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

    // Hoist the per-itemType request templates once. The sweep iterates
    // ~18k items; rebuilding the ImageRequest per iteration (which
    // reads the auth store and re-serializes the URL) is wasted work
    // since only the ID varies. Cache the URL prefix/suffix and auth
    // headers once and string-substitute the ID + variant px per fetch.
    const templates = buildTemplates(server.id);

    // Cursor-based dispatch instead of queue.shift() — workers each
    // grab their next index via a shared monotonic counter, avoiding
    // the O(n) array rebuild cost and the implicit shared-state
    // serialization point.
    let cursor = 0;

    // Adaptive backoff. Rolling latency window over the last
    // BACKOFF_WINDOW completed fetches. If the average exceeds
    // BACKOFF_THRESHOLD_MS we pause new dispatches for BACKOFF_PAUSE_MS
    // and cap effective concurrency in half until latency recovers.
    const BACKOFF_WINDOW = 8;
    const BACKOFF_THRESHOLD_MS = 5_000;
    const BACKOFF_PAUSE_MS = 2_000;
    const latencyWindow: number[] = [];
    let cappedConcurrency = concurrency;
    let lastBackoffAt = 0;
    const recordLatency = (ms: number): void => {
        latencyWindow.push(ms);
        if (latencyWindow.length > BACKOFF_WINDOW) latencyWindow.shift();
    };
    const shouldBackOff = (): boolean => {
        if (latencyWindow.length < BACKOFF_WINDOW) return false;
        const avg = latencyWindow.reduce((a, b) => a + b, 0) / latencyWindow.length;
        return avg > BACKOFF_THRESHOLD_MS;
    };

    // Per-worker state for diagnostics. Tracks what each worker is
    // currently doing so the periodic snapshot can show the entire
    // worker pool's state at once — useful when "the sweep is stuck"
    // because we can see which workers are blocked on which items.
    type WorkerState = { itemId?: string; startedAt: number; status: string };
    const workerStates: WorkerState[] = Array.from({ length: concurrency }, () => ({
        startedAt: Date.now(),
        status: 'idle',
    }));

    // Periodic worker-pool snapshot. Every 15s, log what every worker
    // is currently doing — `status` field shows whether the worker is
    // idle, fetching, or post-processing (writing to Dexie). Catches
    // the case where N workers are wedged on identical items (server
    // returning a single item slowly) vs distributed work.
    const POOL_SNAPSHOT_MS = 15_000;
    let lastPoolSnapshotAt = Date.now();
    const maybeSnapshotPool = (): void => {
        const now = Date.now();
        if (now - lastPoolSnapshotAt < POOL_SNAPSHOT_MS) return;
        lastPoolSnapshotAt = now;
        const summary = workerStates.map((w, i) => ({
            elapsedMs: now - w.startedAt,
            itemId: w.itemId,
            status: w.status,
            worker: i,
        }));
        const activeFetches = summary.filter((s) => s.status === 'fetching').length;
        const longRunning = summary.filter(
            (s) => s.status === 'fetching' && s.elapsedMs > 10_000,
        ).length;
        const latencyAvg =
            latencyWindow.length > 0
                ? Math.round(latencyWindow.reduce((a, b) => a + b, 0) / latencyWindow.length)
                : 0;
        console.info('[cache] thumbnails sweep: pool snapshot', {
            activeFetches,
            cappedConcurrency,
            cursor,
            done,
            fetched,
            longRunning,
            queueRemaining: pending.length - cursor,
            recentLatencyAvgMs: latencyAvg,
            workers: summary,
        });
    };

    const workers: Promise<void>[] = [];

    const work = async (workerId: number): Promise<void> => {
        while (cursor < pending.length) {
            if (signal.aborted) return;
            maybeSnapshotPool();
            if (workerId >= cappedConcurrency) {
                workerStates[workerId] = {
                    itemId: undefined,
                    startedAt: Date.now(),
                    status: 'paused (backoff cap)',
                };
                // Adaptive cap: this worker is over the current cap;
                // sleep briefly and re-check. If latency recovers we
                // come back online.
                await new Promise((r) => setTimeout(r, BACKOFF_PAUSE_MS));
                continue;
            }
            const idx = cursor;
            cursor += 1;
            if (idx >= pending.length) return;
            const next = pending[idx];
            const template = templates[next.itemType];
            if (!template) {
                done += 1;
                skipped += 1;
                continue;
            }
            const wasCached = isUnitCached(next);
            if (wasCached) {
                // Every variant this unit would produce is already cached —
                // skip without a Dexie round-trip or a network request.
                done += 1;
                skipped += 1;
                flushProgress();
                continue;
            }
            const itemStart = Date.now();
            workerStates[workerId] = {
                itemId: next.itemId,
                startedAt: itemStart,
                status: 'fetching',
            };
            const stuckTimer = setTimeout(() => {
                console.warn('[cache] thumbnails sweep: worker stuck >5s on item', {
                    itemId: next.itemId,
                    workerId,
                });
            }, 5_000);
            try {
                const { bytes } =
                    cfg.mode === 'download'
                        ? await fetchDownloadUnit(next, template, signal)
                        : await fetchDownscaleUnit(next, template, cfg, signal);
                bytesDownloaded += bytes;
                if (bytes > 0) {
                    fetched += 1;
                    markUnitCached(next);
                } else {
                    // Treat a zero-byte result as a (negative-cached) skip so a
                    // re-scan doesn't re-attempt it within the miss TTL.
                    markUnitCached(next);
                    skipped += 1;
                }
                const elapsedMs = Date.now() - itemStart;
                recordLatency(elapsedMs);
                if (elapsedMs > 5_000) {
                    console.info('[cache] thumbnails sweep: slow item recovered', {
                        bytes,
                        elapsedMs,
                        itemId: next.itemId,
                        workerId,
                    });
                }
            } catch (err) {
                failed += 1;
                recordLatency(Date.now() - itemStart);
                console.warn('[cache] thumbnails sweep: fetch failed', {
                    err: (err as Error).message,
                    item: next.itemId,
                });
            } finally {
                clearTimeout(stuckTimer);
                workerStates[workerId] = {
                    itemId: undefined,
                    startedAt: Date.now(),
                    status: 'between-items',
                };
            }
            done += 1;
            flushProgress();

            // Adaptive concurrency: if rolling latency suggests the
            // server is overloaded, halve effective concurrency and
            // pause new dispatches briefly. Recover by ramping cap
            // back up as latency drops.
            const nowTs = Date.now();
            if (shouldBackOff() && nowTs - lastBackoffAt > BACKOFF_PAUSE_MS * 2) {
                lastBackoffAt = nowTs;
                cappedConcurrency = Math.max(1, Math.floor(cappedConcurrency / 2));
                console.warn('[cache] thumbnails sweep: backing off', {
                    avgLatencyMs: Math.round(
                        latencyWindow.reduce((a, b) => a + b, 0) / latencyWindow.length,
                    ),
                    newCap: cappedConcurrency,
                });
                latencyWindow.length = 0;
                await new Promise((r) => setTimeout(r, BACKOFF_PAUSE_MS));
            } else if (cappedConcurrency < concurrency && latencyWindow.length >= BACKOFF_WINDOW) {
                const avg = latencyWindow.reduce((a, b) => a + b, 0) / latencyWindow.length;
                if (avg < BACKOFF_THRESHOLD_MS / 2) {
                    cappedConcurrency = Math.min(concurrency, cappedConcurrency + 1);
                }
            }

            if (done >= 50 && failed / done > 0.25 && nowTs - lastAnomalyWarnAt > 10_000) {
                lastAnomalyWarnAt = nowTs;
                console.warn('[cache] thumbnails sweep: ANOMALY: failure rate high', {
                    done,
                    failed,
                    failureRatio: failed / done,
                });
            }
        }
    };

    for (let i = 0; i < concurrency; i += 1) {
        workers.push(work(i));
    }

    await Promise.all(workers);

    // Make sure the final tick lands in the store even if it would
    // have been throttled — the user should see the completed total.
    flushProgress(true);

    if (signal.aborted) {
        console.warn('[cache] thumbnails sweep: aborted', { done, total });
        // Even on abort, clear the sweep state so the dashboard
        // doesn't show a frozen progress bar after the user pauses.
        actions.setSweep(undefined);
        return;
    }

    console.info('[cache] thumbnails sweep: complete', {
        bytes: bytesDownloaded,
        durationMs: Date.now() - startedAt,
        failed,
        fetched,
        items: total,
        skipped,
    });

    // Update the user-visible thumbnail count to reflect what we just
    // wrote (only blob rows; miss markers are excluded). Without this
    // the dashboard stays at the last lifecycle-restored count even
    // after a fresh sweep filled the table.
    if (db) {
        try {
            const [totalThumbs, missThumbs] = await Promise.all([
                db.thumbnails.count(),
                db.thumbnails.where('MissAt').above(0).count(),
            ]);
            actions.setEntityCount('thumbnails', totalThumbs - missThumbs);
        } catch (err) {
            console.warn('[cache] thumbnails sweep: post-count failed', err);
        }
    }

    // CRITICAL: clear the in-store sweep state so the dashboard moves
    // from "Syncing Thumbnails…" back to idle. Without this the
    // useSmoothSweep hook keeps interpolating the last progress
    // object indefinitely (and the `Math.min(total - 1, …)` clamp
    // pins the displayed counter at total-1 forever).
    actions.setSweep(undefined);

    // Run a single eviction pass now that the sweep is done. During
    // the sweep the per-write evict() listener in eviction.ts is
    // gated off (it would otherwise scan the ByteSize index every
    // 250ms and serialize against the worker pool). Catching up now
    // keeps the cap honored.
    try {
        await evict();
    } catch (err) {
        console.warn('[cache] thumbnails sweep: post-evict failed', err);
    }
};
