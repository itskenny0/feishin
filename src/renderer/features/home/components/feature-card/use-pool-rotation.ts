import { useCallback, useEffect, useRef, useState } from 'react';

import { ROTATE_INTERVAL_MS } from '/@/renderer/features/home/components/feature-card/feature-card-shell';

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
    const pausedRef = useRef(false);

    // Reset to a random starting point whenever the pool changes size — picking
    // 0 every time would mean the same item shows on every home-page visit.
    useEffect(() => {
        if (poolSize === 0) return;
        setIndex(pickRandomIndex(poolSize));
    }, [poolSize]);

    useEffect(() => {
        if (poolSize < 2) return undefined;
        const id = window.setInterval(() => {
            if (pausedRef.current) return;
            setIndex((prev) => pickRandomIndex(poolSize, prev));
        }, ROTATE_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [poolSize]);

    const reshuffle = useCallback(() => {
        if (poolSize === 0) return;
        setIndex((prev) => pickRandomIndex(poolSize, prev));
    }, [poolSize]);

    const setPaused = useCallback((p: boolean) => {
        pausedRef.current = p;
    }, []);

    return { index, reshuffle, setPaused };
};
