import { useEffect, useRef } from 'react';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';

/**
 * Detects an edge-swipe gesture and fires a callback.
 *
 * Used to make a drawer feel "native": when the user lays a finger near
 * the left edge of the screen (within `edgePx` of x=0) and then drags
 * inward past `triggerPx`, the callback fires once. Gesture is cancelled
 * if the move is mostly vertical (probably a scroll) or if the pointer
 * is lifted before the threshold is met.
 *
 * Skips entirely on non-touch input (mouse/pen) so desktop users aren't
 * surprised by drawer pops while reaching for the sidebar.
 */
interface UseEdgeSwipeOptions {
    /** Disable the hook (e.g. on desktop shell or when drawer already open). */
    disabled?: boolean;
    /** How close to the left edge the gesture must start (CSS px). */
    edgePx?: number;
    /** Fired once when the swipe crosses the trigger threshold. */
    onSwipeOpen: () => void;
    /** Inward distance required before firing (CSS px). */
    triggerPx?: number;
}

export const useEdgeSwipe = ({
    disabled,
    edgePx = 24,
    onSwipeOpen,
    triggerPx = 60,
}: UseEdgeSwipeOptions) => {
    const startRef = useRef<null | { x: number; y: number }>(null);
    const firedRef = useRef(false);
    const primaryPointerIdRef = useRef<null | number>(null);
    // Track concurrent pointers — a second finger landing during an edge
    // swipe means the user is doing something else (pinching, two-finger
    // gesture) and the drawer should NOT pop open.
    const activePointersRef = useRef<Set<number>>(new Set());

    useEffect(() => {
        if (disabled) return;

        const activePointers = activePointersRef.current;
        activePointers.clear();
        startRef.current = null;
        firedRef.current = false;
        primaryPointerIdRef.current = null;

        const reset = () => {
            startRef.current = null;
            primaryPointerIdRef.current = null;
        };

        const handleStart = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            activePointers.add(event.pointerId);
            // Multi-touch: if the user already has a finger down, the
            // new pointer is a second finger and we should abort the
            // pending edge swipe instead of resetting startRef to it.
            if (activePointers.size > 1) {
                reset();
                return;
            }
            if (event.clientX > edgePx) return;
            // If a child element (slider thumb, custom drag target)
            // already consumed the pointerdown, don't conflict with it
            // — the user is interacting with that element, not the
            // edge of the screen.
            if (event.defaultPrevented) return;
            // Also bail if the touch began on an interactive element
            // near the edge: input, button, [role=slider], etc. Use
            // event.target rather than composedPath since we listen on
            // window.
            const target = event.target as Element | null;
            if (target?.closest?.('input, button, [role="slider"], [role="button"]')) {
                return;
            }
            startRef.current = { x: event.clientX, y: event.clientY };
            firedRef.current = false;
            primaryPointerIdRef.current = event.pointerId;
        };

        const handleMove = (event: PointerEvent) => {
            const start = startRef.current;
            if (!start || firedRef.current) return;
            // Only the pointer that armed the gesture matters; a stray
            // second finger drifting sideways shouldn't push past the
            // trigger threshold.
            if (
                primaryPointerIdRef.current !== null &&
                event.pointerId !== primaryPointerIdRef.current
            ) {
                return;
            }
            const dx = event.clientX - start.x;
            const dy = Math.abs(event.clientY - start.y);
            // Reject if the gesture is mostly vertical — that's a scroll,
            // not an edge-swipe. The 1.4x slack keeps small finger drift
            // from killing the gesture early.
            if (dy > Math.abs(dx) * 1.4) {
                reset();
                return;
            }
            if (dx >= triggerPx) {
                firedRef.current = true;
                triggerHaptic('selection');
                onSwipeOpen();
                reset();
            }
        };

        const handleEnd = (event: PointerEvent) => {
            activePointers.delete(event.pointerId);
            // Only clear the gesture state when the primary pointer
            // lifts — releasing a second finger shouldn't kill an
            // otherwise-valid edge swipe.
            if (
                primaryPointerIdRef.current === null ||
                event.pointerId === primaryPointerIdRef.current
            ) {
                reset();
            }
        };

        window.addEventListener('pointerdown', handleStart, { passive: true });
        window.addEventListener('pointermove', handleMove, { passive: true });
        window.addEventListener('pointerup', handleEnd, { passive: true });
        window.addEventListener('pointercancel', handleEnd, { passive: true });

        return () => {
            window.removeEventListener('pointerdown', handleStart);
            window.removeEventListener('pointermove', handleMove);
            window.removeEventListener('pointerup', handleEnd);
            window.removeEventListener('pointercancel', handleEnd);
            activePointers.clear();
        };
    }, [disabled, edgePx, onSwipeOpen, triggerPx]);
};
