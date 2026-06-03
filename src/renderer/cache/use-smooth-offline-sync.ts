// useSmoothOfflineSync — rAF-interpolated view of the live offline download
// progress (cache store `offlineSync`). Between the per-item store updates the
// done/bytes counters are extrapolated from itemsPerSec / bytesPerSec so the
// banner + settings panel animate at >=20fps instead of stepping once per
// downloaded song. Mirrors the cache-sweep smoothing precedent
// (use-smooth-sweep.ts) so both progress surfaces feel identical.

import { useEffect, useState } from 'react';

import type { OfflineSyncProgress } from './store';

import { useCacheStore } from './store';

import { useSettingsStore } from '/@/renderer/store';

const RENDER_INTERVAL_MS = 1000 / 20; // >=20fps
const CAP_SEC = 2; // don't extrapolate past 2s of a stale update

export const useSmoothOfflineSync = (): OfflineSyncProgress | undefined => {
    const sync = useCacheStore((s) => s.offlineSync);
    const smoothing = useSettingsStore((s) => s.localCache?.sweepProgressSmoothing ?? true);
    const [view, setView] = useState<OfflineSyncProgress | undefined>(sync);

    useEffect(() => {
        if (!sync) {
            setView(undefined);
            return undefined;
        }
        if (!smoothing) {
            setView(sync);
            return undefined;
        }
        const baselineNow = performance.now();
        const baseDone = sync.done;
        const baseBytes = sync.bytesDownloaded;
        const { bytesPerSec, estimatedTotalBytes, itemsPerSec, total } = sync;
        let raf = 0;
        let last = 0;
        const tick = (now: number) => {
            raf = requestAnimationFrame(tick);
            if (now - last < RENDER_INTERVAL_MS) return;
            last = now;
            const elapsed = Math.min(CAP_SEC, (now - baselineNow) / 1000);
            const done =
                total !== undefined
                    ? Math.min(
                          baseDone >= total ? total : total - 1,
                          baseDone + elapsed * itemsPerSec,
                      )
                    : baseDone + elapsed * itemsPerSec;
            const bytes = estimatedTotalBytes
                ? Math.min(estimatedTotalBytes, baseBytes + elapsed * bytesPerSec)
                : baseBytes + elapsed * bytesPerSec;
            setView({ ...sync, bytesDownloaded: bytes, done });
        };
        raf = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(raf);
    }, [sync, smoothing]);

    return smoothing ? view : sync;
};
