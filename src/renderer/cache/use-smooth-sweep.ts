import { useEffect, useState } from 'react';

import { useCacheStore } from './store';

export interface SmoothSweepView {
    bytesDownloaded: number;
    bytesPerSec: number;
    done: number;
    entity: 'albums' | 'artists' | 'favorites' | 'genres' | 'playlists' | 'songs' | undefined;
    estimatedTotalBytes: number | undefined;
    itemsPerSec: number;
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
        const { entity } = sweep;

        let raf = 0;
        const tick = () => {
            const elapsedSec = (performance.now() - baselineNow) / 1000;
            // Clamp `done` to never overshoot `total - 1` when total is
            // known — we don't want the chip to claim "done" before the
            // real signal lands.
            const interpolatedDone = total
                ? Math.min(total - 1, baselineDone + elapsedSec * itemsPerSec)
                : baselineDone + elapsedSec * itemsPerSec;
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
