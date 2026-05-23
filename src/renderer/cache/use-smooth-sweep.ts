import { useEffect, useState } from 'react';

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

/**
 * Subscribes to useCacheStore.sweep and returns an interpolated view that
 * updates at the display refresh rate (typically 60 fps, comfortably above
 * the >= 20 fps requirement) via requestAnimationFrame. Between real
 * per-page updates from the sweep engine, `done` and `bytesDownloaded`
 * advance optimistically using the stored `itemsPerSec` / `bytesPerSec`
 * rates. When a real update lands (the underlying `sweep` reference
 * changes), the interpolation baseline resets so the animation stays
 * anchored to ground truth.
 *
 * Returns an `EMPTY_VIEW` shape (entity === undefined) when no sweep is
 * active. Consumers can guard on `entity` to render nothing.
 */
export const useSmoothSweep = (): SmoothSweepView => {
    const sweep = useCacheStore((s) => s.sweep);
    const [view, setView] = useState<SmoothSweepView>(EMPTY_VIEW);

    useEffect(() => {
        if (!sweep) {
            setView(EMPTY_VIEW);
            return undefined;
        }

        // Baseline at the moment this sweep object was emitted by the
        // store. We don't have a per-update timestamp on `progress`, so we
        // use `performance.now()` at the moment we observe the new sweep
        // ref.
        const baselineNow = performance.now();
        const baselineDone = sweep.progress.done;
        const baselineBytes = sweep.progress.bytesDownloaded;
        const { itemsPerSec } = sweep.progress;
        const { bytesPerSec } = sweep.progress;
        const { total } = sweep.progress;
        const { estimatedTotalBytes } = sweep.progress;
        const { startedAt } = sweep.progress;
        const { phase } = sweep.progress;
        const { pageIndex } = sweep.progress;
        const { pageTotal } = sweep.progress;
        const { entity } = sweep;

        let raf = 0;
        // Cap how far the interpolator can run past the last real
        // update. Without this, a worker pool that stalls right after
        // a burst (e.g. fetches all hanging) leaves the smoother
        // happily extrapolating off the stale itemsPerSec rate — the
        // UI flew from 1.3k items to 17k while real `done` never moved.
        // 2s keeps us responsive on healthy sweeps without lying for
        // minutes on a stuck one.
        const EXTRAPOLATION_CAP_SEC = 2;
        const tick = () => {
            const rawElapsed = (performance.now() - baselineNow) / 1000;
            const elapsedSec = Math.min(EXTRAPOLATION_CAP_SEC, rawElapsed);
            // Clamp extrapolation to `total - 1` so the UI doesn't
            // claim done before the real signal lands — UNLESS the
            // baseline itself already reached `total`, in which case
            // showing `total` is correct (the sweep is finishing).
            // Previously this pinned the displayed counter at
            // total-1 forever when the sweep ended cleanly.
            let interpolatedDone: number;
            if (total !== undefined) {
                const cap = baselineDone >= total ? total : total - 1;
                interpolatedDone = Math.min(cap, baselineDone + elapsedSec * itemsPerSec);
            } else {
                interpolatedDone = baselineDone + elapsedSec * itemsPerSec;
            }
            const interpolatedBytes = estimatedTotalBytes
                ? Math.min(estimatedTotalBytes, baselineBytes + elapsedSec * bytesPerSec)
                : baselineBytes + elapsedSec * bytesPerSec;
            setView({
                bytesDownloaded: interpolatedBytes,
                bytesPerSec,
                done: interpolatedDone,
                entity,
                estimatedTotalBytes,
                itemsPerSec,
                pageIndex,
                pageTotal,
                phase,
                startedAt,
                total,
            });
            raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [sweep]);

    return view;
};
