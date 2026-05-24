import type { LibraryCacheDb } from '../db';
import type { EntityType } from '../types';

import { useCacheStore } from '../store';

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
            done: itemsDone,
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
    while (!signal.aborted) {
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
                    done: itemsDone,
                    estimatedTotalBytes:
                        total !== undefined && itemsDone > 0
                            ? bytesDownloaded * (total / itemsDone)
                            : undefined,
                    itemsPerSec: itemsDone / elapsedSec,
                    pageIndex,
                    pageTotal,
                    phase: 'fetching',
                    startedAt: sweepStartedAt,
                    total,
                },
            });
        }
        let result: { items: TItem[]; total: number };
        try {
            result = await fetchPage(startIndex, pageSize, signal);
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || signal.aborted) {
                console.info(`[cache] sweep:${entity} aborted during fetch`, { startIndex });
                return;
            }
            if (isSweepNetworkError(err)) {
                console.warn(
                    `[cache] sweep:${entity} page failed (network) — checkpoint preserved for resume`,
                    {
                        error: (err as Error)?.message,
                        startIndex,
                    },
                );
                return;
            }
            console.warn(`[cache] sweep:${entity} page failed`, { error: err, startIndex });
            throw err;
        }

        if (signal.aborted) break;

        total = result.total;
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
        const itemsPerSec = elapsed > 0 ? itemsDone / elapsed : 0;

        // Approximate wire size of this page by JSON-stringifying each item.
        // UTF-16 character counts inflate vs. real UTF-8 bytes, but for the
        // ASCII-heavy Jellyfin metadata payloads this is a reasonable proxy.
        const pageBytes = pageItems.reduce((a, it) => a + JSON.stringify(it).length, 0);
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
        if (initialTotal !== undefined && result.total !== initialTotal) {
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
        // pageSize) since small trailing pages are naturally slower
        // per-item due to fixed request overhead.
        const isLastPage = pageItems.length < pageSize;
        if (!isLastPage && lastPageRate > 5 && pageRate < lastPageRate * 0.25) {
            console.warn(`[cache] sweep:${entity} ANOMALY: throughput drop`, {
                currentRate: Math.round(pageRate),
                previousRate: Math.round(lastPageRate),
                startIndex,
            });
        }
        lastPageRate = pageRate;

        if (pageItems.length > 0) {
            await writePage(db, pageItems);
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

        // Persist progress so we can resume on next launch.
        const nextStart = startIndex + pageItems.length;
        await db.syncMeta.put({
            EntityType: entity,
            hydrationState: 'partial',
            lastFullSyncAt: existingMeta?.lastFullSyncAt,
            lastSweepAt: pageStartedAt,
            nextStartIndex: nextStart,
            pausedUntil: undefined,
            totalCount: total,
        });

        const updatedPageTotal = total !== undefined ? Math.ceil(total / pageSize) : undefined;
        actions.setSweep({
            entity,
            progress: {
                bytesDownloaded,
                bytesPerSec,
                done: itemsDone,
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
        if (pageItems.length < pageSize || itemsDone >= total) {
            break;
        }

        startIndex = nextStart;
    }

    if (signal.aborted) {
        console.info(`[cache] sweep:${entity} aborted`, { itemsDone, startIndex });
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
};
