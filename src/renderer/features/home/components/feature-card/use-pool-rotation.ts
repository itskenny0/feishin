import { useCallback, useEffect, useState } from 'react';

import { ROTATE_INTERVAL_MS } from '/@/renderer/features/home/components/feature-card/feature-card-shell';
import { isFeatureCardHovered } from '/@/renderer/features/home/components/feature-card/hover-signal';

const pickRandomIndex = (length: number, exclude: null | number = null): number => {
    if (length <= 1) return 0;
    let next = Math.floor(Math.random() * length);
    if (exclude !== null && next === exclude) {
        next = (next + 1) % length;
    }
    return next;
};

/**
 * Auto-rotation through a pool of candidates. Picks a random index initially,
 * advances every {@link ROTATE_INTERVAL_MS} ms, and reshuffles on demand.
 * Rotation pauses while {@link pausedRef} resolves to true (typically a mouse-
 * enter hover flag), but this hook owns the timer either way.
 *
 * Returns {index, reshuffle, paused-tracker setters} for the consumer.
 */
export const usePoolRotation = (poolSize: number) => {
    const [index, setIndex] = useState(0);

    // Reset to a random starting point whenever the pool changes size — picking
    // 0 every time would mean the same item shows on every home-page visit.
    useEffect(() => {
        if (poolSize === 0) return;
        setIndex(pickRandomIndex(poolSize));
    }, [poolSize]);

    // Re-arm the rotation timer whenever the index changes — either from the
    // auto-rotation itself or from manual prev/next/reshuffle. This way a
    // user-driven change resets the 30s budget rather than firing a confusing
    // auto-rotation moments after the user just navigated.
    useEffect(() => {
        if (poolSize < 2) return undefined;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const tick = () => {
            if (cancelled) return;
            // Hover-pause is global so any single hover freezes the entire
            // rotation chain (including Surprise Me's outer wrapper). Re-check
            // shortly rather than skipping a beat outright.
            if (isFeatureCardHovered()) {
                timer = setTimeout(tick, 1_000);
                return;
            }
            setIndex((prev) => pickRandomIndex(poolSize, prev));
        };
        timer = setTimeout(tick, ROTATE_INTERVAL_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [poolSize, index]);

    const reshuffle = useCallback(() => {
        if (poolSize === 0) return;
        setIndex((prev) => pickRandomIndex(poolSize, prev));
    }, [poolSize]);

    // Sequential navigation — used by the prev/next arrows on the shell. Wraps
    // around at the ends so the user can always advance regardless of the
    // current position.
    const goPrev = useCallback(() => {
        if (poolSize === 0) return;
        setIndex((prev) => (prev - 1 + poolSize) % poolSize);
    }, [poolSize]);

    const goNext = useCallback(() => {
        if (poolSize === 0) return;
        setIndex((prev) => (prev + 1) % poolSize);
    }, [poolSize]);

    return { goNext, goPrev, index, reshuffle };
};
