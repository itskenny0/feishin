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

        console.info(`[cache] sweep:${entity} page`, {
            bytesDownloaded,
            bytesPerSec: Math.round(bytesPerSec),
            estimatedTotalBytes,
            fetched: pageItems.length,
            itemsPerSec: Math.round(itemsPerSec),
            pageBytes,
            startIndex,
            totalServer: result.total,
        });

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
