import { useCallback, useRef } from 'react';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';

/**
 * Detects a horizontal swipe and fires direction-specific callbacks.
 *
 * Returns pointerdown/move/up/cancel handlers to spread onto an element.
 * On touch input only — desktop mice keep their normal click behaviour.
 * A drag of {@link triggerPx} (default 60) in the X axis fires onSwipeLeft
 * (drag left = next, like Spotify) or onSwipeRight (drag right = previous).
 * Vertical drift cancels the gesture so accidental scrolls don't fire.
 *
 * Pure-tap interactions remain unaffected because the timer doesn't run —
 * we only react to actual movement past the threshold.
 */
interface UseHorizontalSwipeOptions {
    disabled?: boolean;
    onSwipeLeft?: () => void;
    onSwipeRight?: () => void;
    triggerPx?: number;
}

export const useHorizontalSwipe = ({
    disabled,
    onSwipeLeft,
    onSwipeRight,
    triggerPx = 60,
}: UseHorizontalSwipeOptions) => {
    const startRef = useRef<null | { x: number; y: number }>(null);
    const firedRef = useRef(false);

    const onPointerDown = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (disabled) return;
            if (event.pointerType !== 'touch') return;
            startRef.current = { x: event.clientX, y: event.clientY };
            firedRef.current = false;
        },
        [disabled],
    );

    const onPointerMove = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            const start = startRef.current;
            if (!start || firedRef.current) return;
            const dx = event.clientX - start.x;
            const dy = Math.abs(event.clientY - start.y);
            // Cancel if mostly vertical — probably a scroll on the
            // surrounding page rather than a horizontal swipe.
            if (dy > Math.abs(dx) * 1.2) {
                startRef.current = null;
                return;
            }
            if (Math.abs(dx) >= triggerPx) {
                firedRef.current = true;
                triggerHaptic('selection');
                if (dx < 0) {
                    onSwipeLeft?.();
                } else {
                    onSwipeRight?.();
                }
                startRef.current = null;
            }
        },
        [onSwipeLeft, onSwipeRight, triggerPx],
    );

    const onPointerUp = useCallback(() => {
        startRef.current = null;
    }, []);

    const onPointerCancel = useCallback(() => {
        startRef.current = null;
    }, []);

    return { onPointerCancel, onPointerDown, onPointerMove, onPointerUp };
};
