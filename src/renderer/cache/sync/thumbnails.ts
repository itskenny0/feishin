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
    persistThumbnailFields,
    resolveThumbnailWithBytes,
    rewriteUrlToVariantSize,
} from '/@/renderer/cache/images';
import { useCacheStore } from '/@/renderer/cache/store';
import { createBackoffController } from '/@/renderer/cache/sync/backoff';
import {
    type EnabledVariant,
    enabledVariants,
    variantConfigHash,
} from '/@/renderer/cache/variant-config';
import { downscaleVariantsPooled } from '/@/renderer/cache/variant-downscale-pool';
import { getIsOnline, subscribeIsOnline } from '/@/renderer/lib/network-status';
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

    // The bulk sweep pre-caches BOUNDED thumbnail sizes only — never the
    // full-resolution original (`px === 0`, the fullScreen variant), even when
    // it's enabled in settings. Originals are multi-megabyte; pre-fetching one
    // per library item is gigabytes, and on a slow/phone-hosted Jellyfin the
    // adaptive backoff floors the sweep to a crawl so even the small thumbnails
    // never finish. The fullScreen original still loads (and caches) lazily on
    // demand via `resolveThumbnail` when the now-playing view is opened — it's
    // just not bulk-prefetched.
    const enabled = enabledVariants(cfg).filter((v) => v.px > 0);
    if (enabled.length === 0) return [];

    // Downscale source fetch must be at least the largest enabled variant so
    // nothing upscales. `enabled` is sorted ascending, so the final entry is the
    // largest bounded variant.
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
 * Outcome of a single sweep work unit. The distinction between `missing` and
 * `transient` is load-bearing for correctness on a flaky network:
 *
 *  - `fetched`:   a blob landed in Dexie. Mark the unit cached.
 *  - `missing`:   the server AUTHORITATIVELY said no artwork (HTTP 404 / a
 *                 fresh negative-cache marker). A negative marker was written;
 *                 mark the unit cached so we don't re-ask every pass.
 *  - `transient`: the fetch failed for a NON-authoritative reason (timeout,
 *                 connection reset, server unreachable, decode error). NOTHING
 *                 authoritative was written — leave the unit UNCACHED so it is
 *                 retried later in the sweep / on the next launch. A transient
 *                 failure must NEVER look like "no artwork".
 */
type UnitOutcome = 'fetched' | 'missing' | 'transient';

interface UnitResult {
    bytes: number;
    outcome: UnitOutcome;
}

/**
 * Fetch + persist one DOWNLOAD-mode work unit: request the cover at the
 * variant's px directly from the server and store it under `[itemId, variant]`
 * via the shared resolver (which handles dedup, miss markers, and the write).
 */
const fetchDownloadUnit = async (
    pending: PendingThumbnail,
    template: RequestTemplate,
    signal: AbortSignal,
): Promise<UnitResult> => {
    if (signal.aborted) return { bytes: 0, outcome: 'transient' };
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0, outcome: 'transient' };

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
    if (result.bytes > 0) return { bytes: result.bytes, outcome: 'fetched' };
    // `noArtwork` === an authoritative 404 (the resolver wrote the MissAt
    // marker). Anything else with zero bytes is a transient failure — the
    // resolver did NOT write a negative marker, so we must retry, not skip.
    return { bytes: 0, outcome: result.noArtwork ? 'missing' : 'transient' };
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
): Promise<UnitResult> => {
    if (signal.aborted) return { bytes: 0, outcome: 'transient' };
    const db = getActiveCacheDb();
    if (!db) return { bytes: 0, outcome: 'transient' };

    const variants = pending.downscaleVariants ?? [];
    // No variants to produce is a config no-op, not a fetch failure — treat it
    // as authoritative so we don't spin retrying a unit that can never produce.
    if (variants.length === 0) return { bytes: 0, outcome: 'missing' };

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
                // Authoritative 404 — a negative marker now exists for every
                // variant. Safe to mark the unit done.
                return { bytes: 0, outcome: 'missing' };
            }
            // Any other non-OK status (5xx, 429, proxy error) is NOT
            // authoritative — the artwork may well exist. Do not write a
            // negative marker; retry later.
            return { bytes: 0, outcome: 'transient' };
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
        // Timeout / connection error / abort — transient, retry later.
        return { bytes: 0, outcome: 'transient' };
    } finally {
        clearTimeout(timeoutId);
        signal.removeEventListener('abort', upstreamAbort);
    }

    if (signal.aborted || db !== getActiveCacheDb()) return { bytes: 0, outcome: 'transient' };

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
        // Local decode/encode failure — the source bytes arrived but we
        // couldn't process them. Transient (could be transient memory
        // pressure on the worker); retry rather than mark "no artwork".
        return { bytes: 0, outcome: 'transient' };
    }

    if (signal.aborted || db !== getActiveCacheDb()) return { bytes: 0, outcome: 'transient' };

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
                const blobFields = await persistThumbnailFields(pending.itemId, variant, blob);
                await db.thumbnails.put({
                    __cachedAt: now,
                    __cfgHash: cfgHash,
                    // Always present; idb overrides via blobFields, fs sets Path.
                    Blob: undefined,
                    ByteSize: blob.size,
                    Etag: undefined,
                    Format: format,
                    ItemId: pending.itemId,
                    LastUsed: now,
                    MissAt: undefined,
                    Size: variantPx.get(variant) ?? 0,
                    Variant: variant,
                    ...blobFields,
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

    return { bytes, outcome: 'fetched' };
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

    // Connectivity gate. While offline the worker pool parks (no fetches, no
    // failure recording, no queue burn) and resumes from the SAME cursor once
    // connectivity returns. `paused` is surfaced in the sweep progress so the
    // dashboard shows "paused (offline)" rather than a frozen counter.
    let paused = !getIsOnline();
    if (paused) {
        console.info('[sync] thumbnails sweep: starting paused — offline');
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
                paused: paused ? 'offline' : undefined,
                startedAt,
                total,
            },
        });
    };

    flushProgress(true);

    // Wake-on-reconnect: a connectivity transition resolves any parked
    // workers' wait so they re-check `getIsOnline()` immediately rather than
    // polling. We keep a single subscription for the whole sweep and notify
    // all parked waiters on every transition; each waiter re-evaluates and
    // either proceeds (online) or re-parks (still offline).
    const onlineWaiters = new Set<() => void>();
    // Abort must also wake every parked waiter so a paused sweep tears down
    // promptly when the user cancels / the server switches instead of hanging
    // on the 1s safety poll forever.
    const onAbortWake = (): void => {
        for (const wake of [...onlineWaiters]) wake();
    };
    signal.addEventListener('abort', onAbortWake);
    const unsubscribeOnline = subscribeIsOnline(() => {
        const online = getIsOnline();
        if (online && paused) {
            paused = false;
            console.info('[sync] thumbnails sweep: connectivity returned — resuming', {
                cursor,
            });
            flushProgress(true);
        } else if (!online && !paused) {
            paused = true;
            console.info('[sync] thumbnails sweep: connectivity lost — pausing', { cursor });
            flushProgress(true);
        }
        // Wake every parked waiter so it re-checks the (possibly still-offline)
        // signal. A 1s safety re-poll in `waitUntilOnline` covers the case
        // where the transition fired before the waiter parked.
        for (const wake of [...onlineWaiters]) wake();
    });

    // Park the caller until connectivity returns. Re-checks `getIsOnline()`
    // both on every connectivity transition AND on a 1s safety timer (so we
    // can't miss a transition that landed between the check and the park).
    const waitUntilOnline = async (): Promise<void> => {
        while (!signal.aborted && !getIsOnline()) {
            paused = true;
            flushProgress(true);
            await new Promise<void>((resolve) => {
                const wake = (): void => {
                    onlineWaiters.delete(wake);
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(wake, 1_000);
                onlineWaiters.add(wake);
            });
        }
        if (getIsOnline() && paused) {
            paused = false;
            flushProgress(true);
        }
    };

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

    // Adaptive backoff (see createBackoffController for the rationale).
    // Symmetric: halve on overload, double after a streak of fast items, so a
    // recovered server ramps back to the ceiling in a handful of items rather
    // than the old +1-per-fast crawl that could floor near 1 forever.
    const BACKOFF_WINDOW = 8;
    const BACKOFF_THRESHOLD_MS = 5_000;
    const BACKOFF_PAUSE_MS = 2_000;
    // Re-check interval for workers parked above the current cap. Kept short so
    // a transient floor doesn't strand N-1 workers for a full BACKOFF_PAUSE_MS
    // after the cap recovers.
    const OVER_CAP_RECHECK_MS = 500;
    // Any item whose measured wall-clock exceeds this is a background/doze
    // FREEZE artifact, not a real latency — the fetch itself times out at 20s,
    // so >30s means the JS context was frozen while the clock ran. We neither
    // feed it to the backoff controller (below) nor let it poison throughput.
    const FREEZE_SAMPLE_MS = 30_000;
    // Never strand the sweep below this many concurrent fetches: a single slow
    // window used to floor the cap at 1 and (pre-time-ramp) never recover.
    // Capped at the configured concurrency so a user who deliberately sets a
    // low concurrency is honoured.
    const BACKOFF_FLOOR = Math.min(4, concurrency);
    const backoff = createBackoffController({
        ceiling: concurrency,
        // Bound each sample so one doze-inflated reading can't dominate the
        // window average (belt to the freeze-skip suspenders below).
        clampMs: FREEZE_SAMPLE_MS,
        fastItemMs: BACKOFF_THRESHOLD_MS / 2,
        floor: BACKOFF_FLOOR,
        pauseMs: BACKOFF_PAUSE_MS,
        recoverStreak: 3,
        thresholdMs: BACKOFF_THRESHOLD_MS,
        // Unconditional time-based ramp-up so the cap escapes the floor even
        // when steady-state items are slow-but-healthy (never under fastItemMs).
        timeRampMs: 8_000,
        window: BACKOFF_WINDOW,
    });
    // `cappedConcurrency` mirrors the controller's cap for the diagnostics
    // snapshot + the over-cap worker park check.
    let cappedConcurrency = backoff.cap;

    // Per-worker state for diagnostics. Tracks what each worker is
    // currently doing so the periodic snapshot can show the entire
    // worker pool's state at once — useful when "the sweep is stuck"
    // because we can see which workers are blocked on which items.
    type WorkerState = { itemId?: string; startedAt: number; status: string };
    const workerStates: WorkerState[] = Array.from({ length: concurrency }, () => ({
        startedAt: Date.now(),
        status: 'idle',
    }));

    // Per-item stuck warnings flooded telemetry on slow servers (dozens of
    // lines per sweep, one per slow item). Warn for the first few, then
    // sample 1-in-50 with a running count — the 15s pool snapshot below
    // already shows WHICH items are wedged.
    let stuckWarnCount = 0;
    const warnWorkerStuck = (itemId: string, workerId: number): void => {
        stuckWarnCount += 1;
        if (stuckWarnCount <= 5 || stuckWarnCount % 50 === 0) {
            console.warn('[cache] thumbnails sweep: worker stuck >5s on item', {
                itemId,
                stuckSoFar: stuckWarnCount,
                workerId,
            });
        }
    };

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
        const latencyAvg = backoff.recentAvgMs();
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
            // Connectivity gate: while offline, park here WITHOUT advancing the
            // cursor or recording a failure. The item we would have fetched is
            // still pending, so we resume from exactly where we stopped.
            if (!getIsOnline()) {
                workerStates[workerId] = {
                    itemId: undefined,
                    startedAt: Date.now(),
                    status: 'paused (offline)',
                };
                await waitUntilOnline();
                if (signal.aborted) return;
                continue;
            }
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
                await new Promise((r) => setTimeout(r, OVER_CAP_RECHECK_MS));
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
                warnWorkerStuck(next.itemId, workerId);
            }, 5_000);
            // `transient` outcomes (and thrown errors) must NOT count as a fast
            // success for backoff recovery, even when they complete quickly.
            let itemOutcome: UnitOutcome = 'transient';
            try {
                const { bytes, outcome } =
                    cfg.mode === 'download'
                        ? await fetchDownloadUnit(next, template, signal)
                        : await fetchDownscaleUnit(next, template, cfg, signal);
                itemOutcome = outcome;
                bytesDownloaded += bytes;
                if (outcome === 'fetched') {
                    fetched += 1;
                    markUnitCached(next);
                } else if (outcome === 'missing') {
                    // Authoritative 404 — a negative marker was written. Mark
                    // the unit cached so a re-scan honors the miss TTL.
                    markUnitCached(next);
                    skipped += 1;
                } else {
                    // TRANSIENT failure (timeout / unreachable / non-404 HTTP /
                    // decode error). NOTHING authoritative was written — do NOT
                    // mark the unit cached. Leaving it pending means it is
                    // retried later in the sweep and on the next launch, so a
                    // network blip never strands an item as "no artwork".
                    failed += 1;
                    if (!getIsOnline()) {
                        // The failure coincided with the link dropping. The
                        // top-of-loop gate will park the next iteration; this
                        // unit remains UNCACHED and is retried next launch.
                        console.info('[sync] thumbnails sweep: fetch failed while offline', {
                            itemId: next.itemId,
                        });
                    }
                }
                const elapsedMs = Date.now() - itemStart;
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
                itemOutcome = 'transient';
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

            // Adaptive concurrency. The controller halves the cap on overload
            // and ramps it back up on a streak of fast items OR on the
            // unconditional time-ramp (so a slow-but-healthy server escapes the
            // floor even when no item is ever under fastItemMs).
            const nowTs = Date.now();
            const itemElapsedMs = nowTs - itemStart;
            // Freeze-skip: a backgrounded/dozed WebView freezes this worker's
            // awaits while the wall clock keeps running, so `itemElapsedMs` can
            // be minutes. Feeding that to the controller is what floored the cap
            // at 1 for the entire run (observed 22-min "items"). A real item
            // tops out near the 20s fetch timeout, so anything past
            // FREEZE_SAMPLE_MS is a freeze artifact — don't record it at all.
            let action: 'backoff' | 'none' | 'rampup' = 'none';
            if (itemElapsedMs <= FREEZE_SAMPLE_MS) {
                action = backoff.record(itemElapsedMs, itemOutcome === 'transient', nowTs);
            }
            cappedConcurrency = backoff.cap;
            if (action === 'backoff') {
                console.warn('[cache] thumbnails sweep: backing off', {
                    avgLatencyMs: backoff.recentAvgMs(),
                    newCap: cappedConcurrency,
                });
                await new Promise((r) => setTimeout(r, BACKOFF_PAUSE_MS));
            } else if (action === 'rampup') {
                console.info('[cache] thumbnails sweep: ramping up', {
                    newCap: cappedConcurrency,
                });
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

    try {
        await Promise.all(workers);
    } finally {
        // Tear down the connectivity subscription + abort wake-up so the
        // sweep leaves no listeners behind (a leak across re-syncs).
        unsubscribeOnline();
        signal.removeEventListener('abort', onAbortWake);
    }

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
