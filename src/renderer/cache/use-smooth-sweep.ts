import { useMemo } from 'react';

import { useCacheStore } from './store';

export interface SmoothSweepView {
    bytesDownloaded: number;
    bytesPerSec: number;
    done: number;
    entity:
        | 'albums'
        | 'artists'
        | 'favorites'
        | 'genres'
        | 'lyrics'
        | 'playlists'
        | 'songs'
        | 'thumbnails'
        | undefined;
    estimatedTotalBytes: number | undefined;
    itemsPerSec: number;
    pageIndex: number | undefined;
    pageTotal: number | undefined;
    phase: 'fetching' | 'processing' | undefined;
    startedAt: number | undefined;
    total: number | undefined;
}

const EMPTY_VIEW: SmoothSweepView = {
    bytesDownloaded: 0,
    bytesPerSec: 0,
    done: 0,
    entity: undefined,
    estimatedTotalBytes: undefined,
    itemsPerSec: 0,
    pageIndex: undefined,
    pageTotal: undefined,
    phase: undefined,
    startedAt: undefined,
    total: undefined,
};

const sweepToView = (
    sweep: ReturnType<typeof useCacheStore.getState>['sweep'],
): SmoothSweepView => {
    if (!sweep) return EMPTY_VIEW;
    return {
        bytesDownloaded: sweep.progress.bytesDownloaded,
        bytesPerSec: sweep.progress.bytesPerSec,
        done: sweep.progress.done,
        entity: sweep.entity,
        estimatedTotalBytes: sweep.progress.estimatedTotalBytes,
        itemsPerSec: sweep.progress.itemsPerSec,
        pageIndex: sweep.progress.pageIndex,
        pageTotal: sweep.progress.pageTotal,
        phase: sweep.progress.phase,
        startedAt: sweep.progress.startedAt,
        total: sweep.progress.total,
    };
};

/**
 * Raw view of the active sweep from the cache store, memoized on the `sweep`
 * reference (the engine rewrites it ~20×/sec during a sweep). Returns
 * `EMPTY_VIEW` (entity === undefined) when no sweep is active — consumers guard
 * on `entity` to render nothing.
 *
 * The old rAF interpolation ("animate progress bar") was removed: it re-rendered
 * its host at 20fps and, on a heavy host like the settings page, starved the
 * sync workers' async callbacks. Progress now updates at the engine's own
 * per-page cadence; mount this in a small isolated child so only it re-renders.
 */
export const useSmoothSweep = (): SmoothSweepView => {
    const sweep = useCacheStore((s) => s.sweep);
    return useMemo(() => sweepToView(sweep), [sweep]);
};
