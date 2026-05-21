import { RefObject, useEffect, useState } from 'react';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';

/**
 * iOS/Android-style pull-to-refresh gesture detector.
 *
 * Attaches pointer listeners to {@link targetRef}; when the element is at
 * scrollTop === 0 and the user drags downward, exposes the current pull
 * distance (CSS px) so a caller can render an indicator. Once the user
 * releases past {@link triggerPx} the {@link onRefresh} promise is
 * awaited and the indicator returns to 0. Cancels cleanly if the user
 * moves mostly horizontally (a side-swipe) or lifts before threshold.
 *
 * Restricted to pointerType 'touch' so desktop mice can't accidentally
 * yank the page into refresh while click-dragging text.
 */
interface UsePullToRefreshOptions {
    /** True to disable the hook entirely (e.g. on desktop shell). */
    disabled?: boolean;
    /** Async refetch callback. The indicator stays visible until it resolves. */
    onRefresh: () => Promise<void> | void;
    /** Pull distance required before release will trigger refresh (default 80). */
    triggerPx?: number;
}

interface UsePullToRefreshState {
    /** Current pull distance in CSS px, clamped to triggerPx * 1.6. */
    distance: number;
    /** True while we're awaiting onRefresh. */
    refreshing: boolean;
}

export const usePullToRefresh = (
    targetRef: RefObject<HTMLElement | null>,
    { disabled, onRefresh, triggerPx = 80 }: UsePullToRefreshOptions,
): UsePullToRefreshState => {
    const [distance, setDistance] = useState(0);
    const [refreshing, setRefreshing] = useState(false);

    useEffect(() => {
        if (disabled) return;
        const el = targetRef.current;
        if (!el) return;

        let startY = 0;
        let lastDeltaY = 0;
        let active = false;
        let armed = false;

        const handlePointerDown = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            // Only arm when starting at the very top of the scroll area —
            // mid-scroll touches should NOT initiate a refresh.
            if (el.scrollTop > 0) return;
            startY = event.clientY;
            lastDeltaY = 0;
            active = true;
            armed = false;
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (!active) return;
            const deltaY = event.clientY - startY;
            // Going up cancels (user is starting a normal scroll).
            if (deltaY < 0) {
                active = false;
                setDistance(0);
                return;
            }
            // Apply a 0.55 resistance factor so the rubber-band feels weighty
            // rather than 1:1 with the finger.
            const eased = Math.min(triggerPx * 1.6, deltaY * 0.55);
            lastDeltaY = eased;
            setDistance(eased);
            if (!armed && eased >= triggerPx) {
                armed = true;
                triggerHaptic('selection');
            } else if (armed && eased < triggerPx) {
                armed = false;
            }
        };

        const handlePointerUp = async () => {
            if (!active) return;
            active = false;
            if (lastDeltaY >= triggerPx) {
                setRefreshing(true);
                triggerHaptic('impact');
                try {
                    await onRefresh();
                } finally {
                    setRefreshing(false);
                    setDistance(0);
                }
            } else {
                setDistance(0);
            }
        };

        el.addEventListener('pointerdown', handlePointerDown, { passive: true });
        el.addEventListener('pointermove', handlePointerMove, { passive: true });
        el.addEventListener('pointerup', handlePointerUp, { passive: true });
        el.addEventListener('pointercancel', handlePointerUp, { passive: true });

        return () => {
            el.removeEventListener('pointerdown', handlePointerDown);
            el.removeEventListener('pointermove', handlePointerMove);
            el.removeEventListener('pointerup', handlePointerUp);
            el.removeEventListener('pointercancel', handlePointerUp);
        };
    }, [disabled, onRefresh, targetRef, triggerPx]);

    return { distance, refreshing };
};
