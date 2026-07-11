import type { LibraryCacheDb } from '../db';
import type { EntityType } from '../types';

import { useCacheStore } from '../store';
import { getCooldownUntil } from './rate-limit-cooldown';

import { getIsOnline, subscribeIsOnline } from '/@/renderer/lib/network-status';

export interface RunSweepArgs<TItem> {
    ctx: SweepContext;
    // Optional delta-sync params. When `deltaCutoffMs` is set, the
    // fetchPage callback MUST sort newest-first (RECENTLY_ADDED desc);
    // the loop short-circuits once a page's oldest item is older than
    // the cutoff, and items older than the cutoff are filtered out of
    // the page before writePage runs.
    deltaCutoffMs?: number;
    fetchPage: (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ) => Promise<{ items: TItem[]; total: number }>;
    itemDateMs?: (item: TItem) => number | undefined;
    pageSize?: number;
    writePage: (db: LibraryCacheDb, items: TItem[]) => Promise<void>;
}

export interface SweepContext {
    db: LibraryCacheDb;
    entity: EntityType;
    signal: AbortSignal;
}

const DEFAULT_PAGE_SIZE = 500;

// Lock-yield granularity (perf fix #2). A 500-row `bulkPut` inside one rw
// transaction holds the IndexedDB write lock for its whole duration, which
// can starve interactive cache reads (the grid / list `fromCache` path). We
// split each page's write into WRITE_CHUNK_SIZE-row sub-transactions and
// yield the event loop between them so a queued read transaction can
// interleave. Throughput stays acceptable because `bulkPut` is already the
// dominant cost; the extra transaction boundaries are cheap relative to the
// structured-clone of the rows themselves.
const WRITE_CHUNK_SIZE = 125;

// Yield the event loop so a pending IndexedDB read transaction (an
// interactive `fromCache`) can acquire the lock between our write chunks.
// Prefer requestIdleCallback when available (renderer) so we cede during
// browser idle time; fall back to a macrotask otherwise.
const yieldLock = (): Promise<void> =>
    new Promise((resolve) => {
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(() => resolve(), { timeout: 50 });
        } else {
            setTimeout(resolve, 0);
        }
    });

/**
 * Items/sec a sweep reports. Computed over NEW work only: a resumed sweep seeds
 * `itemsDone` with the resume cursor (items synced in a previous session) but
 * measures elapsed time only for the current session, so dividing the raw
 * `itemsDone` by elapsed inflates the rate and collapses the dashboard ETA to
 * ~0s when part of the library was already synced. Subtract the resume baseline
 * so the rate (and the ETA derived from it) reflects this session's throughput.
 */
export const sweepItemsPerSec = (
    itemsDone: number,
    resumeBaseline: number,
    elapsedSec: number,
): number => {
    if (elapsedSec <= 0) return 0;
    return Math.max(0, itemsDone - resumeBaseline) / elapsedSec;
};

// Module-level UTF-8 encoder for byte-length accounting. `.length` on a
// JS string returns UTF-16 code units, which understates UTF-8 byte size
// for non-ASCII content. TextEncoder gives the real wire size without
// allocating a Blob per item.
const _utf8Encoder = new TextEncoder();
const utf8ByteLength = (s: string): number => _utf8Encoder.encode(s).length;

export const isSweepNetworkError = (err: unknown): boolean => {
    const name = (err as Error)?.name;
    if (name === 'AbortError') return false;
    const message = (err as Error)?.message ?? '';
    return (
        name === 'TypeError' ||
        name === 'NetworkError' ||
        /network|fetch|offline|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(message)
    );
};

// A page fetch is retried this many times (with exponential backoff) before the
// sweep gives up and preserves its checkpoint for a later resume. Covers a
// transient 5xx from an overloaded server (the controller throws a plain
// `Error('Failed to get …')` on a 502, which is NOT a network error — so
// without this the sweep died on the first blip and the wizard froze mid-entity).
const SWEEP_FETCH_ATTEMPTS = 3;
let sweepRetryBaseMs = 1500;
/** Test hook: shorten (or zero) the per-page retry backoff. */
export const setSweepRetryBaseMsForTests = (ms: number): void => {
    sweepRetryBaseMs = ms;
};

// Upper bound on a single retry's sleep, independent of `sweepRetryBaseMs` /
// attempt count — insurance against an unbounded wait if SWEEP_FETCH_ATTEMPTS
// ever grows.
const SWEEP_RETRY_MAX_DELAY_MS = 20_000;

// Floor a page's requested `limit` can shrink to under repeated retryable
// failures (see fetchPageWithRetry below). Small enough to make a real
// difference against a ~30s proxy timeout on a heavy Recursive/Limit=5000
// query, large enough that per-page HTTP round-trip overhead doesn't dominate.
const MIN_SWEEP_PAGE_SIZE = 50;
// Consecutive no-retry-needed pages required, once running below the caller's
// configured pageSize, before we step the size back up toward it. Mirrors the
// symmetric halve-down/step-up shape the thumbnail sweep's adaptive
// concurrency controller uses (backoff.ts) — quick to shrink under pressure,
// cautious but steady to recover once pages start completing cleanly again.
const PAGE_SIZE_RAMP_STREAK = 3;

const sweepSleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
        );
    });

/**
 * Exponential backoff with equal jitter: half of the raw exponential value is
 * guaranteed, the other half is randomized. A purely deterministic backoff
 * (the prior behaviour) makes every client's sweep hit an overloaded server at
 * the SAME instants after a shared blip — e.g. every open client's page-1
 * retry lands in the same 1.5s window — which just re-creates the thundering
 * herd it's supposed to be easing. Capped at SWEEP_RETRY_MAX_DELAY_MS so a
 * large `sweepRetryBaseMs` / attempt count can't produce a multi-minute sleep.
 */
const jitteredRetryDelayMs = (attempt: number): number => {
    const raw = Math.min(SWEEP_RETRY_MAX_DELAY_MS, sweepRetryBaseMs * 2 ** (attempt - 1));
    const half = raw / 2;
    return Math.round(half + Math.random() * half);
};

/**
 * Fetch one page, retrying a transient failure (e.g. a 502 from an overloaded
 * server) with bounded, jittered exponential backoff. Never retries an abort.
 * Re-throws the last error once attempts are exhausted so the caller can
 * preserve the checkpoint and resume later.
 *
 * Also shrinks the requested page size on a retry: the heavy Recursive/
 * Limit=5000-style queries that trip the ~30s proxy timeout / 502 this is
 * guarding against are exactly the ones a smaller `limit` is most likely to
 * fix, so a retry with a reduced size is a genuine second attempt at success,
 * not just a delayed repeat of the same failing request. Returns the limit
 * that actually succeeded (`limitUsed`) so the caller can decide whether to
 * keep the reduced size for subsequent pages.
 */
const fetchPageWithRetry = async <TItem>(
    fetchPage: (limit: number) => Promise<{ items: TItem[]; total: number }>,
    signal: AbortSignal,
    entity: EntityType,
    startIndex: number,
    initialLimit: number,
): Promise<{ items: TItem[]; limitUsed: number; total: number }> => {
    let lastErr: unknown;
    let limit = initialLimit;
    // Never shrink-target ABOVE what the caller asked for on this page. A
    // typical caller's pageSize (500) is well above MIN_SWEEP_PAGE_SIZE, so
    // this is normally just MIN_SWEEP_PAGE_SIZE — but if a future caller ever
    // configures a smaller pageSize, `Math.max(MIN_SWEEP_PAGE_SIZE, …)` alone
    // would perversely GROW the request on a "reduction" (e.g. floor(20/2)=10
    // clamped up to 50, larger than the 20 the caller wanted).
    const shrinkFloor = Math.min(MIN_SWEEP_PAGE_SIZE, initialLimit);
    for (let attempt = 1; attempt <= SWEEP_FETCH_ATTEMPTS; attempt += 1) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError');
        try {
            const result = await fetchPage(limit);
            return { ...result, limitUsed: limit };
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
            lastErr = err;
            if (attempt >= SWEEP_FETCH_ATTEMPTS) break;
            const reducedLimit = Math.max(shrinkFloor, Math.floor(limit / 2));
            const willShrink = reducedLimit < limit;
            const delay = jitteredRetryDelayMs(attempt);
            console.warn(
                `[sync] sweep:${entity} page attempt ${attempt}/${SWEEP_FETCH_ATTEMPTS} failed, retrying in ${delay}ms`,
                {
                    error: (err as Error)?.message,
                    nextLimit: willShrink ? reducedLimit : limit,
                    startIndex,
                },
            );
            if (willShrink) limit = reducedLimit;
            await sweepSleep(delay, signal);
        }
    }
    throw lastErr;
};

export const runSweep = async <TItem>(args: RunSweepArgs<TItem>): Promise<void> => {
    const {
        ctx,
        deltaCutoffMs,
        fetchPage,
        itemDateMs,
        pageSize = DEFAULT_PAGE_SIZE,
        writePage,
    } = args;
    const { db, entity, signal } = ctx;

    const actions = useCacheStore.getState().actions;

    // Connectivity gate. While offline the page loop parks BEFORE issuing the
    // next fetch — no network request, no failure recording — and resumes from
    // the same `startIndex` cursor once connectivity returns. The persisted
    // syncMeta checkpoint is untouched while parked, so an app kill mid-pause
    // resumes from the last committed page just like any other restart.
    const onlineWaiters = new Set<() => void>();
    const onAbortWake = (): void => {
        for (const wake of [...onlineWaiters]) wake();
    };
    signal.addEventListener('abort', onAbortWake);
    const unsubscribeOnline = subscribeIsOnline(() => {
        for (const wake of [...onlineWaiters]) wake();
    });
    // Idempotent teardown of the connectivity subscription + abort wake-up.
    // Called on every exit path so a sweep never leaks a listener across
    // re-syncs / app lifetime.
    let cleanedUp = false;
    const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribeOnline();
        signal.removeEventListener('abort', onAbortWake);
    };
    const waitUntilOnline = async (
        emitPaused: () => void,
        emitResumed: () => void,
    ): Promise<void> => {
        if (getIsOnline() || signal.aborted) return;
        console.info(`[sync] sweep:${entity} connectivity lost — pausing`, { startIndex });
        emitPaused();
        while (!signal.aborted && !getIsOnline()) {
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
        if (!signal.aborted) {
            console.info(`[sync] sweep:${entity} connectivity returned — resuming`, {
                startIndex,
            });
            emitResumed();
        }
    };

    // Rate-limit cooldown gate. `rate-limit-cooldown.ts` is a pool-wide
    // circuit breaker armed by an authoritative 429/503/Retry-After seen
    // ANYWHERE in the sync pipeline (today: the thumbnail sweep, which runs
    // right after every metadata sweep in `hydrate()`, and whose sweep can
    // still be cooling down when a retried `hydrate()` call starts a fresh
    // pass from `albums`). This sweep never ARMS the cooldown itself — the
    // generic `Error` a failed page throws carries no HTTP status (see
    // isSweepNetworkError's comment) — but it costs nothing to HONOR one
    // that's already active rather than immediately hammering a server the
    // app already knows is rate-limited. Bounded by the cooldown module's own
    // 30s clamp, polled so a cooldown that gets extended mid-wait is honored
    // too, and it never touches the syncMeta checkpoint.
    const waitUntilCooldownClears = async (): Promise<void> => {
        let deadline = getCooldownUntil();
        if (deadline <= Date.now() || signal.aborted) return;
        console.info(`[sync] sweep:${entity} rate-limit cooldown active — pausing`, {
            startIndex,
            waitMs: deadline - Date.now(),
        });
        while (!signal.aborted && deadline > Date.now()) {
            await sweepSleep(Math.min(1_000, deadline - Date.now()), signal).catch(() => undefined);
            deadline = getCooldownUntil();
        }
        if (!signal.aborted) {
            console.info(`[sync] sweep:${entity} rate-limit cooldown cleared — resuming`, {
                startIndex,
            });
        }
    };

    // Resume from where a previous sweep left off. Delta sync ignores
    // the resume marker because it walks the newest-first ordering
    // from page 0 — the previous resume marker was based on a
    // different sort.
    const existingMeta = await db.syncMeta.get(entity);
    const isDelta = deltaCutoffMs !== undefined && itemDateMs !== undefined;
    let startIndex = isDelta ? 0 : (existingMeta?.nextStartIndex ?? 0);
    let total: number | undefined = existingMeta?.totalCount;

    const sweepStartedAt = Date.now();
    let itemsDone = isDelta ? 0 : startIndex;
    // Items already synced before this session started (the resume cursor).
    // Excluded from the items/sec rate so a resumed sweep's ETA isn't inflated.
    const resumeBaseline = itemsDone;
    // DISPLAYED progress = cache completeness, NOT items-processed-this-sweep.
    // Seeded from the live row count and recomputed per page (idempotent
    // bulkPut means it only climbs when genuinely-new rows land). So a resync
    // shows 950/1000 from the first paint instead of racing 0→1000 (which read
    // as a full re-download). `itemsDone` stays the throughput accumulator that
    // feeds the rate — the two are intentionally decoupled.
    let cachedDone = await db
        .table(entity)
        .count()
        .catch(() => itemsDone);
    let bytesDownloaded = 0;
    const initialTotal = total;
    // Per-page rate is used to detect throughput drops; the page log
    // below otherwise reports the running average, which can't see a
    // sudden stall.
    let lastPageRate = 0;

    console.info(`[cache] sweep:${entity} start`, {
        delta: isDelta,
        deltaCutoffMs,
        knownTotal: total,
        resumeFromIndex: startIndex,
    });

    // Emit an initial "fetching" state immediately so the dashboard shows
    // "Syncing <entity>…" from the first page, not "Idle". Without this,
    // entities with slow first pages (e.g. songs ~13s per page) display
    // "Idle" until the page completes.
    actions.setSweep({
        entity,
        progress: {
            bytesDownloaded: 0,
            bytesPerSec: 0,
            done: cachedDone,
            estimatedTotalBytes: undefined,
            itemsPerSec: 0,
            pageIndex: 1,
            pageTotal: total !== undefined ? Math.ceil(total / pageSize) : undefined,
            phase: 'fetching',
            startedAt: sweepStartedAt,
            total,
        },
    });

    let pageIndex = 0;
    // Adaptive page size (see fetchPageWithRetry). Starts at the caller's
    // configured `pageSize` and only ever shrinks in response to an ACTUAL
    // retryable failure, ramping back up after PAGE_SIZE_RAMP_STREAK clean
    // pages. `pageSize` itself is never mutated — it stays the stable
    // denominator for the dashboard's "page X of Y" estimate even while the
    // real requested size adapts underneath it.
    let effectivePageSize = pageSize;
    let pageSizeRampStreak = 0;
    while (!signal.aborted) {
        // Park here while offline — BEFORE incrementing pageIndex or touching
        // the network — and resume from the same `startIndex` once online.
        const pageTotalForPause = total !== undefined ? Math.ceil(total / pageSize) : undefined;
        await waitUntilOnline(
            () =>
                actions.setSweep({
                    entity,
                    progress: {
                        bytesDownloaded,
                        bytesPerSec: 0,
                        done: cachedDone,
                        estimatedTotalBytes: undefined,
                        itemsPerSec: 0,
                        pageIndex: pageIndex + 1,
                        pageTotal: pageTotalForPause,
                        paused: 'offline',
                        phase: 'fetching',
                        startedAt: sweepStartedAt,
                        total,
                    },
                }),
            () =>
                actions.setSweep({
                    entity,
                    progress: {
                        bytesDownloaded,
                        bytesPerSec: 0,
                        done: cachedDone,
                        estimatedTotalBytes: undefined,
                        itemsPerSec: 0,
                        pageIndex: pageIndex + 1,
                        pageTotal: pageTotalForPause,
                        phase: 'fetching',
                        startedAt: sweepStartedAt,
                        total,
                    },
                }),
        );
        if (signal.aborted) break;
        // Park here too — same reasoning as the offline gate above — if a
        // pool-wide rate-limit cooldown armed elsewhere is still active.
        await waitUntilCooldownClears();
        if (signal.aborted) break;
        pageIndex += 1;
        const pageTotal = total !== undefined ? Math.ceil(total / pageSize) : undefined;
        const pageStartedAt = Date.now();
        // Flip the sweep into the 'fetching' sub-phase BEFORE we
        // await the network so the dashboard can label this period
        // clearly. On slow Jellyfin instances a 500-item page fetch
        // can take 20-30s with no visible progress; without this
        // hint the user sees a frozen counter and assumes the sweep
        // is stuck. This applies from page 2 onward (page 1 is handled
        // by the initial state emitted above).
        if (itemsDone > 0) {
            const elapsedSec = Math.max(1, (pageStartedAt - sweepStartedAt) / 1000);
            actions.setSweep({
                entity,
                progress: {
                    bytesDownloaded,
                    bytesPerSec: bytesDownloaded / elapsedSec,
                    done: cachedDone,
                    estimatedTotalBytes:
                        total !== undefined && itemsDone > 0
                            ? bytesDownloaded * (total / itemsDone)
                            : undefined,
                    itemsPerSec: sweepItemsPerSec(itemsDone, resumeBaseline, elapsedSec),
                    pageIndex,
                    pageTotal,
                    phase: 'fetching',
                    startedAt: sweepStartedAt,
                    total,
                },
            });
        }
        let result: { items: TItem[]; total: number };
        let limitUsed = effectivePageSize;
        try {
            const fetched = await fetchPageWithRetry(
                (limit) => fetchPage(startIndex, limit, signal),
                signal,
                entity,
                startIndex,
                effectivePageSize,
            );
            result = fetched;
            limitUsed = fetched.limitUsed;
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || signal.aborted) {
                console.info(`[cache] sweep:${entity} aborted during fetch`, { startIndex });
                cleanup();
                return;
            }
            // After bounded retries the page still failed — a persistent network
            // error OR an overloaded server (5xx). Preserve the checkpoint and
            // stop THIS sweep cleanly WITHOUT throwing: hydrate then continues to
            // the other entities (so they still make progress), and the sync
            // runner retries this entity from the saved cursor. Throwing here
            // made a single flaky entity skip every entity after it and froze the
            // first-sync wizard at the failing offset.
            const kind = isSweepNetworkError(err) ? 'network' : 'server';
            console.warn(
                `[sync] sweep:${entity} page failed (${kind}) after retries — checkpoint preserved for resume`,
                { error: (err as Error)?.message, startIndex },
            );
            cleanup();
            return;
        }

        if (signal.aborted) break;

        // Adaptive page size follow-through: adopt a reduced size for
        // subsequent pages (a server that's struggling on one page is likely
        // still struggling on the next), or — once running below the
        // configured pageSize — ramp back up after a streak of pages that
        // needed no retry, so a recovered server isn't kept crawling forever.
        if (limitUsed < effectivePageSize) {
            console.warn(`[sync] sweep:${entity} page size reduced after retries`, {
                from: effectivePageSize,
                startIndex,
                to: limitUsed,
            });
            effectivePageSize = limitUsed;
            pageSizeRampStreak = 0;
        } else if (effectivePageSize < pageSize) {
            pageSizeRampStreak += 1;
            if (pageSizeRampStreak >= PAGE_SIZE_RAMP_STREAK) {
                const restored = Math.min(pageSize, effectivePageSize * 2);
                console.info(`[sync] sweep:${entity} page size restored after recovery`, {
                    from: effectivePageSize,
                    startIndex,
                    to: restored,
                });
                effectivePageSize = restored;
                pageSizeRampStreak = 0;
            }
        }

        // Pages 2..N may suppress EnableTotalRecordCount (a per-page server
        // COUNT(*) cost), returning total:0. NEVER overwrite the page-1 total
        // with a suppressed 0 — that would make `itemsDone >= total` true and
        // silently truncate the sweep. Page 1 (and any page that does report a
        // real total) updates it.
        if (result.total > 0) total = result.total;
        let pageItems = result.items;

        // Delta-sync short-circuit. The page is in newest-first order;
        // walk it and find the first item older than the cutoff. Drop
        // that item and everything after it (already cached on a prior
        // sweep), and stop fetching more pages once we've passed the
        // cutoff frontier.
        let deltaCutoffReached = false;
        if (isDelta && itemDateMs && deltaCutoffMs !== undefined) {
            let firstOldIdx = -1;
            for (let i = 0; i < pageItems.length; i += 1) {
                const d = itemDateMs(pageItems[i]);
                if (d !== undefined && d < deltaCutoffMs) {
                    firstOldIdx = i;
                    break;
                }
            }
            if (firstOldIdx >= 0) {
                pageItems = pageItems.slice(0, firstOldIdx);
                deltaCutoffReached = true;
            }
        }

        itemsDone += pageItems.length;
        const elapsed = (Date.now() - sweepStartedAt) / 1000;
        const itemsPerSec = sweepItemsPerSec(itemsDone, resumeBaseline, elapsed);

        // Approximate wire size of this page by JSON-stringifying each item
        // and measuring its real UTF-8 byte length via TextEncoder.
        const pageBytes = pageItems.reduce((a, it) => a + utf8ByteLength(JSON.stringify(it)), 0);
        bytesDownloaded += pageBytes;
        const bytesPerSec = bytesDownloaded / Math.max(1, elapsed);
        const estimatedTotalBytes =
            total !== undefined && itemsDone > 0
                ? bytesDownloaded * (total / itemsDone)
                : undefined;

        const pageElapsedMs = Date.now() - pageStartedAt;
        const pageRate = pageElapsedMs > 0 ? (pageItems.length * 1000) / pageElapsedMs : 0;

        console.info(`[cache] sweep:${entity} page`, {
            bytesDownloaded,
            bytesPerSec: Math.round(bytesPerSec),
            estimatedTotalBytes,
            fetched: pageItems.length,
            fetchedRaw: result.items.length,
            itemsPerSec: Math.round(itemsPerSec),
            pageBytes,
            pageElapsedMs,
            pageRate: Math.round(pageRate),
            startIndex,
            totalServer: result.total,
        });

        // Anomaly: server total changed between calls. Jellyfin shouldn't
        // do this for stable libraries; if it does, our totalCount/done
        // accounting goes off and the progress UI lies. Worth flagging.
        if (initialTotal !== undefined && result.total > 0 && result.total !== initialTotal) {
            console.warn(`[cache] sweep:${entity} ANOMALY: server total changed`, {
                from: initialTotal,
                startIndex,
                to: result.total,
            });
        }

        // Anomaly: page returned zero items but we haven't reached the
        // claimed total. Usually means the server paginated weird or hit
        // a transient cache, but it can also mean the sweep is stuck —
        // we'd otherwise exit the loop below and silently mark this
        // entity "full" with a partial dataset.
        // Use result.items.length (pre-filter) so a delta-sync page
        // that the client filtered to zero doesn't fire a false alarm.
        if (result.items.length === 0 && itemsDone < result.total) {
            console.warn(`[cache] sweep:${entity} ANOMALY: empty page below total`, {
                claimedTotal: result.total,
                itemsDone,
                startIndex,
            });
        }

        // Anomaly: a single page took >30s. Usually a network hiccup or
        // an overloaded server. Log so we can correlate with user reports
        // of "sync stalled".
        if (pageElapsedMs > 30_000) {
            console.warn(`[cache] sweep:${entity} ANOMALY: slow page`, {
                pageElapsedMs,
                pageItems: pageItems.length,
                startIndex,
            });
        }

        // Anomaly: this page's throughput collapsed compared to the
        // previous one (current rate < 25% of the prior page). Catches
        // a server going from healthy → degraded mid-sweep before the
        // running average smears over it. Skip the last page (items <
        // limitUsed, the actual size requested for THIS page — not the
        // stable `pageSize` denominator, which can be stale once the
        // adaptive size has shrunk) since small trailing pages are
        // naturally slower per-item due to fixed request overhead.
        const isLastPage = pageItems.length < limitUsed;
        if (!isLastPage && lastPageRate > 5 && pageRate < lastPageRate * 0.25) {
            console.warn(`[cache] sweep:${entity} ANOMALY: throughput drop`, {
                currentRate: Math.round(pageRate),
                previousRate: Math.round(lastPageRate),
                startIndex,
            });
        }
        lastPageRate = pageRate;

        // Atomicity: write the page rows AND the syncMeta resume marker
        // in a single Dexie transaction so a crash mid-write can never
        // leave the entity table at offset N+1 while the syncMeta resume
        // marker still says N. Without this, a torn write would either
        // re-fetch a page on next launch (safe — bulkPut is idempotent)
        // OR skip rows that the writer thought were persisted (data
        // loss). The transaction boundary now exactly matches the
        // checkpoint boundary the resume logic depends on.
        const nextStart = startIndex + pageItems.length;
        const metaRow = {
            EntityType: entity,
            hydrationState: 'partial' as const,
            lastFullSyncAt: existingMeta?.lastFullSyncAt,
            lastSweepAt: pageStartedAt,
            nextStartIndex: nextStart,
            pausedUntil: undefined,
            totalCount: total,
        };
        try {
            // Resolve the entity store by name so the same transaction
            // boundary works for every sweep regardless of which table
            // its writePage targets.
            const entityTable = db.table(entity);
            if (pageItems.length > WRITE_CHUNK_SIZE) {
                // Large page: write in WRITE_CHUNK_SIZE-row sub-transactions
                // and yield the lock between them so interactive reads can
                // interleave. The syncMeta resume marker is written LAST, in
                // its own transaction, only after every row chunk committed —
                // a crash mid-page leaves the marker at the old offset, so the
                // page is simply re-fetched on resume (bulkPut is idempotent).
                const chunks = Math.ceil(pageItems.length / WRITE_CHUNK_SIZE);
                for (let c = 0; c < chunks; c += 1) {
                    if (signal.aborted) break;
                    const slice = pageItems.slice(c * WRITE_CHUNK_SIZE, (c + 1) * WRITE_CHUNK_SIZE);
                    await db.transaction('rw', entityTable, async () => {
                        await writePage(db, slice);
                    });
                    if (c < chunks - 1) {
                        console.info(`[cache] sweep:${entity} yielding lock`, {
                            chunk: c + 1,
                            chunks,
                            chunkSize: slice.length,
                            startIndex,
                        });
                        await yieldLock();
                    }
                }
                if (!signal.aborted) {
                    await db.transaction('rw', db.syncMeta, async () => {
                        await db.syncMeta.put(metaRow);
                    });
                }
            } else {
                // Small page: keep the rows + resume marker in a single
                // transaction so the checkpoint boundary matches exactly.
                await db.transaction('rw', entityTable, db.syncMeta, async () => {
                    if (pageItems.length > 0) {
                        await writePage(db, pageItems);
                    }
                    await db.syncMeta.put(metaRow);
                });
            }
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || signal.aborted) {
                console.info(`[cache] sweep:${entity} aborted during write`, { startIndex });
                cleanup();
                return;
            }
            console.warn(`[cache] sweep:${entity} page transaction failed`, {
                error: (err as Error)?.message,
                startIndex,
            });
            cleanup();
            throw err;
        }

        // Live entity-count + hydration-state update so the dashboard
        // shows real numbers as the sweep progresses, not "0 none"
        // until the very last page lands. In delta mode we DON'T
        // overwrite the count with `itemsDone` (which is only the
        // newly-fetched delta) — the entity already has rows from
        // previous full syncs, and clobbering the count to the small
        // delta number would make the dashboard appear to lose data.
        if (!isDelta) {
            actions.setEntityCount(entity, itemsDone);
        }
        actions.setHydrationState(entity, 'partial');

        // Recompute cache completeness after this page's rows committed (one
        // cheap indexed count per page — never per item). Only climbs when
        // genuinely-new rows landed (idempotent bulkPut on the stable Id), so a
        // no-op delta resync sits at ~full instead of racing up from 0.
        cachedDone = await db
            .table(entity)
            .count()
            .catch(() => cachedDone);

        const updatedPageTotal = total !== undefined ? Math.ceil(total / pageSize) : undefined;
        actions.setSweep({
            entity,
            progress: {
                bytesDownloaded,
                bytesPerSec,
                done: cachedDone,
                estimatedTotalBytes,
                itemsPerSec,
                pageIndex,
                pageTotal: updatedPageTotal,
                phase: 'processing',
                startedAt: sweepStartedAt,
                total,
            },
        });

        // Exit conditions: delta cutoff reached, page came back short
        // (last page), or we have fetched everything.
        if (deltaCutoffReached) {
            console.info(`[cache] sweep:${entity} delta cutoff reached`, {
                itemsWritten: itemsDone,
                pageStartIndex: startIndex,
            });
            break;
        }
        // Compare against `limitUsed` — the limit actually requested for
        // THIS page — not the stable `pageSize` denominator. Once adaptive
        // shrinking is in play a full-but-reduced page legitimately returns
        // fewer than `pageSize` items while more of the library remains;
        // comparing against the original constant would read that as "last
        // page" and truncate the sweep.
        if (pageItems.length < limitUsed || (total !== undefined && itemsDone >= total)) {
            break;
        }

        startIndex = nextStart;
    }

    if (signal.aborted) {
        console.info(`[cache] sweep:${entity} aborted`, { itemsDone, startIndex });
        cleanup();
        return;
    }

    // Mark as fully hydrated.
    const now = Date.now();
    console.info(`[cache] sweep:${entity} done`, {
        delta: isDelta,
        durationMs: now - sweepStartedAt,
        itemsDone,
    });
    await db.syncMeta.put({
        EntityType: entity,
        hydrationState: 'full',
        lastFullSyncAt: now,
        lastSweepAt: now,
        nextStartIndex: 0,
        pausedUntil: undefined,
        totalCount: total,
    });

    // In delta mode, recount from Dexie so the dashboard shows the
    // TRUE row count (existing + delta), not just the delta size.
    if (isDelta) {
        try {
            const realCount = await db.table(entity).count();
            actions.setEntityCount(entity, realCount);
        } catch (err) {
            console.warn(`[cache] sweep:${entity} post-count failed`, err);
        }
    } else {
        actions.setEntityCount(entity, itemsDone);
    }
    actions.setHydrationState(entity, 'full');
    actions.setSweep(undefined);
    cleanup();
};
