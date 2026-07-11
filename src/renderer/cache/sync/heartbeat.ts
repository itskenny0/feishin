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
// Ref-count of outstanding start/stop pairs. `hydrate()` can be re-entrant
// (the user triggers a resync while one is already running): it aborts the
// PRIOR run's controller but that prior run's `finally` still calls
// stopSyncHeartbeat with its OWN label — and since the label is
// `full/${server.id}`, a resync of the SAME server produces the identical
// label both times, so label equality can't distinguish "this stop belongs
// to the run that's still active" from "this stop belongs to the run that
// just got superseded". Tracking how many callers currently expect the
// heartbeat to be running (instead of a boolean) fixes that: only the LAST
// matching stop actually tears it down, so a superseded run's cleanup can't
// kill the heartbeat (and, via setSyncActive(false), hide the sync-active UI)
// out from under a sync that's genuinely still going. Every start the module
// receives is 1:1 balanced by hydrate()'s try/finally, so this can't leak.
let activeCount = 0;

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
    activeCount += 1;
    // Idempotent: a re-entrant hydrate() may try to start a second
    // heartbeat; keep the existing timer running and just relabel it.
    if (timer) {
        activeLabel = label;
        console.info('[cache] heartbeat: re-labelled', { activeCount, label });
        return;
    }
    startedAt = Date.now();
    tickCount = 0;
    activeLabel = label;
    // Mark the whole hydration active so the sync chip / dashboard stay visible
    // across the gaps between entity sweeps (where `sweep` is momentarily undefined).
    useCacheStore.getState().actions.setSyncActive(true);
    console.info('[cache] heartbeat: starting', { label, tickMs: TICK_MS });
    timer = setInterval(() => {
        tickCount += 1;
        try {
            console.info('[cache] heartbeat', snapshot());
        } catch (err) {
            // Never let a diagnostic-snapshot glitch (e.g. an unexpected store
            // shape) surface as an uncaught exception from inside a live
            // sync — this tick is purely informational, so degrade to a
            // warning and keep ticking.
            console.warn('[cache] heartbeat: tick failed', { error: (err as Error)?.message });
        }
    }, TICK_MS);
};

export const stopSyncHeartbeat = (label: string): void => {
    if (!timer) return;
    activeCount = Math.max(0, activeCount - 1);
    if (activeCount > 0) {
        // A different (still-running) hydrate() is relying on this heartbeat —
        // this stop came from a run that was superseded before it could
        // finish. Keep it alive; only the matching stop for the run that's
        // still holding a reference tears it down.
        console.info('[cache] heartbeat: stop deferred — still in use', { activeCount, label });
        return;
    }
    clearInterval(timer);
    timer = undefined;
    useCacheStore.getState().actions.setSyncActive(false);
    console.info('[cache] heartbeat: stopped', {
        ...snapshot(),
        finalLabel: label,
    });
};
