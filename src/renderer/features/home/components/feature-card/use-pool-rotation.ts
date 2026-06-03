import { useCallback, useEffect, useState } from 'react';

import { isFeatureCardHovered } from '/@/renderer/features/home/components/feature-card/hover-signal';
import { useHomeFeatureCardRotationIntervalSeconds } from '/@/renderer/store/settings.store';

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
 * advances every `homeFeatureCardRotationIntervalSeconds` (default 30s), and
 * reshuffles on demand. Rotation pauses while a feature card is hovered
 * (`hover-signal.ts`).
 *
 * Returns {index, goPrev, goNext, reshuffle}.
 */
export const usePoolRotation = (poolSize: number) => {
    const rotateIntervalMs = useHomeFeatureCardRotationIntervalSeconds() * 1000;
    // We track both the index AND the pool size it was picked against so we
    // can detect when the pool first transitions from 0 → N and synchronously
    // re-pick during the same render. Without this, the first render with a
    // populated pool would see `index = 0`, which the caller would use to
    // index pool[0] and fire a wasted song-list fetch for an item we never
    // intend to display (auto-rotation immediately moves to a random index).
    const [state, setState] = useState<{ index: number; sizeAtPick: number }>({
        index: 0,
        sizeAtPick: 0,
    });

    // Synchronous in-render reseed when the pool changes size. React allows
    // setState during render as long as it's gated by a condition that
    // converges (here: sizeAtPick === poolSize after the update). On the
    // restarted render the new index is used immediately, so the caller
    // never sees the stale pool[0] state.
    if (poolSize > 0 && state.sizeAtPick !== poolSize) {
        setState({ index: pickRandomIndex(poolSize), sizeAtPick: poolSize });
    }

    const index = state.index;

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
            setState((prev) => ({
                index: pickRandomIndex(poolSize, prev.index),
                sizeAtPick: poolSize,
            }));
        };
        timer = setTimeout(tick, rotateIntervalMs);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [poolSize, index, rotateIntervalMs]);

    const reshuffle = useCallback(() => {
        if (poolSize === 0) return;
        setState((prev) => ({
            index: pickRandomIndex(poolSize, prev.index),
            sizeAtPick: poolSize,
        }));
    }, [poolSize]);

    // Sequential navigation — used by the prev/next arrows on the shell. Wraps
    // around at the ends so the user can always advance regardless of the
    // current position.
    const goPrev = useCallback(() => {
        if (poolSize === 0) return;
        setState((prev) => ({
            index: (prev.index - 1 + poolSize) % poolSize,
            sizeAtPick: poolSize,
        }));
    }, [poolSize]);

    const goNext = useCallback(() => {
        if (poolSize === 0) return;
        setState((prev) => ({
            index: (prev.index + 1) % poolSize,
            sizeAtPick: poolSize,
        }));
    }, [poolSize]);

    return { goNext, goPrev, index, reshuffle };
};
