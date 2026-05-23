import { useCacheStore } from '../store';

// Periodic structured snapshot of the running sync. Runs alongside the
// existing per-page / per-batch logs so the user can watch progress
// even when no individual entity is the bottleneck (e.g. a long
// thumbnail sweep, an idle resume window, a stuck page). Output is one
// `console.info` per tick to keep the log buffer tidy.
const TICK_MS = 10_000;

let timer: ReturnType<typeof setInterval> | undefined;
let startedAt = 0;
let tickCount = 0;
let activeLabel = '';

const snapshot = (): Record<string, unknown> => {
    const st = useCacheStore.getState();
    const sweep = st.sweep;
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    return {
        activeEntity: sweep?.entity,
        bytesDownloaded: sweep?.progress.bytesDownloaded,
        bytesPerSec: sweep ? Math.round(sweep.progress.bytesPerSec) : undefined,
        done: sweep?.progress.done,
        elapsedSec,
        entityCounts: st.entityCounts,
        estimatedTotalBytes: sweep?.progress.estimatedTotalBytes,
        hydrationStates: st.hydrationStates,
        itemsPerSec: sweep ? Math.round(sweep.progress.itemsPerSec) : undefined,
        label: activeLabel,
        pendingMutations: st.pendingMutations,
        tick: tickCount,
        total: sweep?.progress.total,
        totalBytesUsed: st.bytesUsed,
    };
};

export const startSyncHeartbeat = (label: string): void => {
    // Idempotent: a re-entrant hydrate() may try to start a second
    // heartbeat; keep the existing timer and just relabel it.
    if (timer) {
        activeLabel = label;
        console.info('[cache] heartbeat: re-labelled', { label });
        return;
    }
    startedAt = Date.now();
    tickCount = 0;
    activeLabel = label;
    console.info('[cache] heartbeat: starting', { label, tickMs: TICK_MS });
    timer = setInterval(() => {
        tickCount += 1;
        console.info('[cache] heartbeat', snapshot());
    }, TICK_MS);
};

export const stopSyncHeartbeat = (label: string): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    console.info('[cache] heartbeat: stopped', {
        ...snapshot(),
        finalLabel: label,
    });
};
