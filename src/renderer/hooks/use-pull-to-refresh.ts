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
        let primaryPointerId: null | number = null;
        // True once this effect has been torn down (unmount / dep change). The
        // pointer-up handler is async — it awaits onRefresh() — so without this
        // guard its `finally` setRefreshing(false)/setDistance(0) can run after
        // the hook unmounted (e.g. the user navigates away while a slow refetch
        // is still in flight), setting state on an unmounted component.
        let disposed = false;
        // Track every concurrent touch pointer so a second finger landing
        // mid-pull disarms the gesture cleanly (pinch / two-finger scroll
        // should NEVER be interpreted as refresh, otherwise the indicator
        // jitters as one finger drifts vertically while the other anchors).
        const activePointers = new Set<number>();

        const reset = () => {
            active = false;
            armed = false;
            primaryPointerId = null;
            lastDeltaY = 0;
            setDistance(0);
        };

        const handlePointerDown = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            activePointers.add(event.pointerId);

            // Multi-touch: never start a refresh from a non-primary pointer,
            // and if a primary pull was already in flight, abort it.
            if (activePointers.size > 1) {
                if (active) reset();
                return;
            }

            // Only arm when starting at the very top of the scroll area —
            // mid-scroll touches should NOT initiate a refresh.
            if (el.scrollTop > 0) return;
            // Many routes render with their own internal scroll
            // containers; in those cases el.scrollTop stays 0 even when
            // the visible content is scrolled. Walk up from the touch
            // target and abort if any ancestor scrollable is mid-scroll.
            let walker: Element | null = event.target as Element | null;
            while (walker && walker !== el) {
                if (walker.scrollHeight > walker.clientHeight && walker.scrollTop > 0) {
                    return;
                }
                walker = walker.parentElement;
            }
            // Also require the gesture to start in the upper portion of
            // the visible area — a pull that begins halfway down the
            // viewport doesn't read as "refresh". 96px keeps the
            // affordance reachable even on small phones.
            const rect = el.getBoundingClientRect();
            if (event.clientY - rect.top > 96) return;

            startY = event.clientY;
            lastDeltaY = 0;
            active = true;
            armed = false;
            primaryPointerId = event.pointerId;
        };

        const handlePointerMove = (event: PointerEvent) => {
            if (!active) return;
            // Only the pointer that started the gesture drives the indicator —
            // other pointers (e.g. a second finger laid down before the first
            // lifted) shouldn't move the spinner.
            if (event.pointerId !== primaryPointerId) return;
            // If a second touch landed since pointerdown, bail out.
            if (activePointers.size > 1) {
                reset();
                return;
            }
            const deltaY = event.clientY - startY;
            // Going up cancels (user is starting a normal scroll).
            if (deltaY < 0) {
                reset();
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

        const handlePointerUp = async (event: PointerEvent) => {
            activePointers.delete(event.pointerId);
            if (!active) return;
            // Wait for the primary pointer that actually drove the gesture
            // — releasing a non-primary finger first shouldn't fire refresh.
            if (event.pointerId !== primaryPointerId) return;
            const triggered = lastDeltaY >= triggerPx;
            active = false;
            armed = false;
            primaryPointerId = null;
            if (triggered) {
                setRefreshing(true);
                triggerHaptic('impact');
                try {
                    await onRefresh();
                } finally {
                    if (!disposed) {
                        setRefreshing(false);
                        setDistance(0);
                    }
                    lastDeltaY = 0;
                }
            } else {
                setDistance(0);
                lastDeltaY = 0;
            }
        };

        // pointercancel fires when the browser steals the gesture (e.g. system
        // back gesture overlay opens, a scroll claim higher up succeeds,
        // touch-action interrupts). It must NOT trigger refresh — the user
        // never explicitly released past the threshold.
        const handlePointerCancel = (event: PointerEvent) => {
            activePointers.delete(event.pointerId);
            if (!active) return;
            if (event.pointerId !== primaryPointerId && activePointers.size > 0) return;
            reset();
        };

        el.addEventListener('pointerdown', handlePointerDown, { passive: true });
        el.addEventListener('pointermove', handlePointerMove, { passive: true });
        el.addEventListener('pointerup', handlePointerUp, { passive: true });
        el.addEventListener('pointercancel', handlePointerCancel, { passive: true });

        return () => {
            disposed = true;
            el.removeEventListener('pointerdown', handlePointerDown);
            el.removeEventListener('pointermove', handlePointerMove);
            el.removeEventListener('pointerup', handlePointerUp);
            el.removeEventListener('pointercancel', handlePointerCancel);
        };
    }, [disabled, onRefresh, targetRef, triggerPx]);

    return { distance, refreshing };
};
