import type { LibraryCacheDb } from '../db';
import type { EntityType } from '../types';

import { useCacheStore } from '../store';

export interface RunSweepArgs<TItem> {
    ctx: SweepContext;
    fetchPage: (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ) => Promise<{ items: TItem[]; total: number }>;
    pageSize?: number;
    writePage: (db: LibraryCacheDb, items: TItem[]) => Promise<void>;
}

export interface SweepContext {
    db: LibraryCacheDb;
    entity: EntityType;
    signal: AbortSignal;
}

const DEFAULT_PAGE_SIZE = 500;

export const runSweep = async <TItem>(args: RunSweepArgs<TItem>): Promise<void> => {
    const { ctx, fetchPage, pageSize = DEFAULT_PAGE_SIZE, writePage } = args;
    const { db, entity, signal } = ctx;

    const actions = useCacheStore.getState().actions;

    // Resume from where a previous sweep left off.
    const existingMeta = await db.syncMeta.get(entity);
    let startIndex = existingMeta?.nextStartIndex ?? 0;
    let total: number | undefined = existingMeta?.totalCount;

    const sweepStartedAt = Date.now();
    let itemsDone = startIndex; // items already persisted before this run
    let bytesDownloaded = 0;
    const initialTotal = total;
    // Per-page rate is used to detect throughput drops; the page log
    // below otherwise reports the running average, which can't see a
    // sudden stall.
    let lastPageRate = 0;

    console.info(`[cache] sweep:${entity} start`, {
        knownTotal: total,
        resumeFromIndex: startIndex,
    });

    while (!signal.aborted) {
        const pageStartedAt = Date.now();
        let result: { items: TItem[]; total: number };
        try {
            result = await fetchPage(startIndex, pageSize, signal);
        } catch (err) {
            if ((err as Error)?.name === 'AbortError' || signal.aborted) {
                console.info(`[cache] sweep:${entity} aborted during fetch`, { startIndex });
                return;
            }
            console.warn(`[cache] sweep:${entity} page failed`, { error: err, startIndex });
            throw err;
        }

        if (signal.aborted) break;

        total = result.total;
        const pageItems = result.items;

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
        if (pageItems.length === 0 && itemsDone < result.total) {
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
        // running average smears over it.
        if (lastPageRate > 5 && pageRate < lastPageRate * 0.25) {
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

        actions.setSweep({
            entity,
            progress: {
                bytesDownloaded,
                bytesPerSec,
                done: itemsDone,
                estimatedTotalBytes,
                itemsPerSec,
                startedAt: sweepStartedAt,
                total,
            },
        });

        // Exit conditions: either the page came back short (last page), or we
        // have now fetched everything.
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

    actions.setEntityCount(entity, itemsDone);
    actions.setHydrationState(entity, 'full');
    actions.setSweep(undefined);
};
