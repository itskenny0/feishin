// Thumbnail pre-cache sweep. Iterates every album / artist / playlist row
// in Dexie and fetches its thumbnail blob through `resolveThumbnail`. The
// cache stores ONE blob per item at `MAX_CACHE_SIZE` — the resolver
// rewrites the upstream URL to that size and the browser downscales for
// smaller display surfaces. The earlier per-(itemId,size) variant table
// has been collapsed to a single primary key (see db.ts v4 + images.ts),
// so the sweep no longer fans out across `imageRes` buckets.
//
// The sweep is opt-in: an empty `localCache.thumbnailSizes` array means
// "no pre-cache" (the lazy `<BaseImage>` path still fills the table
// incidentally as the user browses). Any non-empty value enables it.

import type { ServerListItem } from '/@/shared/types/domain-types';

import { api } from '/@/renderer/api';
import { getActiveCacheDb } from '/@/renderer/cache/db';
import { evict } from '/@/renderer/cache/eviction';
import { MAX_CACHE_SIZE, resolveThumbnailWithBytes } from '/@/renderer/cache/images';
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
}

/**
 * Collect the items we want to fetch — one entry per (album / artist /
 * playlist) row regardless of any display-size configuration, because the
 * cache holds one blob per item. We attempt every row that has an `id` —
 * `imageId` is unreliable on some servers (Jellyfin omits it from list
 * endpoints even when the entity has artwork accessible via the per-item
 * endpoint), so the earlier `if (!row.Payload?.imageId)` guard was
 * rejecting most candidates. Let the server return 404 instead.
 */
const collectPending = async (): Promise<PendingThumbnail[]> => {
    const db = getActiveCacheDb();
    if (!db) return [];
    const out: PendingThumbnail[] = [];

    const albums = await db.albums.toArray();
    for (const row of albums) {
        if (!row.Id) continue;
        out.push({
            itemId: row.Id,
            itemType: LibraryItem.ALBUM,
            kind: 'album',
        });
    }

    const artists = await db.artists.toArray();
    for (const row of artists) {
        if (!row.Id) continue;
        out.push({
            itemId: row.Id,
            itemType: LibraryItem.ALBUM_ARTIST,
            kind: 'artist',
        });
    }

    const playlists = await db.playlists.toArray();
    for (const row of playlists) {
        if (!row.Id) continue;
        out.push({
            itemId: row.Id,
            itemType: LibraryItem.PLAYLIST,
            kind: 'playlist',
        });
    }

    return out;
};

/**
 * Run one thumbnail fetch through the shared resolver. The resolver
 * dedups in-flight requests, checks the existing Dexie row, and writes
 * back to the table on miss — we don't have to do any of that here. We
 * always request `MAX_CACHE_SIZE` because that's what the resolver
 * persists; the upstream URL is rewritten internally either way, but
 * building the request at the cache size keeps the network request
 * shape identical to what the cache lookup expects.
 *
 * `existingKeys` is a pre-computed set of itemIds built ONCE at sweep
 * start. Without it, each of the 64 workers ran its own
 * `db.thumbnails.get()` against IndexedDB just to discover a row already
 * existed; the user reported 2.6 items/sec on re-syncs because every
 * cached item paid that Dexie round-trip. Bypassing the lookup makes
 * already-cached items effectively free.
 */
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

const fetchOne = async (
    pending: PendingThumbnail,
    template: RequestTemplate,
    signal: AbortSignal,
    existingKeys: Set<string>,
): Promise<{ bytes: number }> => {
    if (signal.aborted) return { bytes: 0 };
    if (existingKeys.has(pending.itemId)) return { bytes: 0 };

    const db = getActiveCacheDb();
    if (!db) return { bytes: 0 };

    const url = template.urlBefore + pending.itemId + template.urlAfter;
    const request = {
        cacheKey: url,
        credentials: template.credentials,
        headers: template.headers,
        url,
    };

    const result = await resolveThumbnailWithBytes(pending.itemId, MAX_CACHE_SIZE, request, {
        signal,
    });
    if (result.bytes > 0) existingKeys.add(pending.itemId);
    return { bytes: result.bytes };
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
    // Empty `thumbnailSizes` array = explicit opt-out. Any non-empty
    // value (the legacy multi-bucket array, or the new sentinel
    // `[MAX_CACHE_SIZE]` written by the dashboard toggle) enables the
    // sweep — the cache stores one blob per item regardless.
    const buckets = localCache?.thumbnailSizes ?? [];
    if (buckets.length === 0) {
        console.info('[cache] thumbnails sweep: pre-cache disabled, skipping');
        return;
    }

    const pending = await collectPending();
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

    // Pre-fetch every existing thumbnail row's itemId so the worker
    // pool can skip them without a Dexie round-trip per item. On a
    // re-sync where the cache is mostly warm this turns a 2.6 items/sec
    // crawl into a near-instant scan.
    //
    // Negative-cache markers (Blob === undefined) are included as long
    // as they're still fresh — the server already told us 404, no point
    // re-asking on every sweep. Once a marker is older than MISS_TTL_MS
    // we let it through so the sweep retries (newly-added artwork on
    // the server should eventually populate). The TTL matches the
    // window used by `resolveThumbnail` in images.ts.
    const MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const db = getActiveCacheDb();
    const existingKeys = new Set<string>();
    let staleMissCount = 0;
    let freshMissCount = 0;
    if (db) {
        try {
            // CRITICAL: do NOT call db.thumbnails.toArray() here — that
            // would pull every Blob into memory. Instead read just the
            // primary keys for the full table (which skips the row
            // store entirely), and separately read only the small
            // miss-marker rows to decide fresh vs stale.
            const [allKeys, missRows] = await Promise.all([
                db.thumbnails.toCollection().primaryKeys() as Promise<string[]>,
                db.thumbnails.where('MissAt').above(0).toArray(),
            ]);
            const now = Date.now();
            const staleMissKeys = new Set<string>();
            for (const row of missRows) {
                const missAt = row.MissAt ?? 0;
                if (now - missAt >= MISS_TTL_MS) {
                    staleMissKeys.add(row.ItemId);
                    staleMissCount += 1;
                } else {
                    freshMissCount += 1;
                }
            }
            for (const itemId of allKeys) {
                if (!staleMissKeys.has(itemId)) existingKeys.add(itemId);
            }
            console.info('[cache] thumbnails sweep: prefetched existing keys', {
                count: existingKeys.size,
                freshMissCount,
                queueToFetch: total - existingKeys.size,
                staleMissCount,
                totalRows: allKeys.length,
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

    // Hoist the per-itemType request templates once. The sweep iterates
    // ~18k items; rebuilding the ImageRequest per iteration (which
    // reads the auth store and re-serializes the URL) is wasted work
    // since only the ID varies. Cache the URL prefix/suffix and auth
    // headers once and string-substitute the ID per fetch.
    const templates: Partial<Record<LibraryItem, RequestTemplate>> = {};
    for (const lt of [LibraryItem.ALBUM, LibraryItem.ALBUM_ARTIST, LibraryItem.PLAYLIST]) {
        const tpl = buildRequestTemplate(server.id, lt);
        if (tpl) templates[lt] = tpl;
    }

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
            const wasCached = existingKeys.has(next.itemId);
            const itemStart = Date.now();
            workerStates[workerId] = {
                itemId: next.itemId,
                startedAt: itemStart,
                status: wasCached ? 'cache-skip' : 'fetching',
            };
            const stuckTimer = setTimeout(() => {
                console.warn('[cache] thumbnails sweep: worker stuck >5s on item', {
                    itemId: next.itemId,
                    workerId,
                });
            }, 5_000);
            try {
                const { bytes } = await fetchOne(next, template, signal, existingKeys);
                bytesDownloaded += bytes;
                if (wasCached) {
                    skipped += 1;
                } else if (bytes > 0) {
                    fetched += 1;
                } else {
                    existingKeys.add(next.itemId);
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
