import { RefObject, useEffect } from 'react';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';

/**
 * Inverted edge-swipe: when a finger lands inside {@link targetRef} and
 * drags horizontally past {@link triggerPx} (in the configured direction),
 * fires {@link onClose}. Used by the mobile drawer to support
 * swipe-to-close so users have a gesture path alongside backdrop-tap.
 *
 * Skips non-touch input. Gesture is rejected if mostly vertical (it would
 * be a scroll inside the drawer body).
 */
interface UseSwipeToCloseOptions {
    /** Direction to detect: 'left' means drag-to-the-left, 'right' means drag-to-the-right. */
    direction?: 'left' | 'right';
    /** Disable the hook entirely. */
    disabled?: boolean;
    /** Fired once when the gesture crosses the threshold. */
    onClose: () => void;
    /** Distance in CSS px required before firing. */
    triggerPx?: number;
}

export const useSwipeToClose = (
    targetRef: RefObject<HTMLElement | null>,
    { direction = 'left', disabled, onClose, triggerPx = 80 }: UseSwipeToCloseOptions,
) => {
    useEffect(() => {
        if (disabled) return;
        const el = targetRef.current;
        if (!el) return;

        let startX = 0;
        let startY = 0;
        let active = false;
        let fired = false;
        let primaryPointerId: null | number = null;
        // Track concurrent pointers so a second finger (pinch / two-finger
        // tap) disarms instead of competing for the close gesture.
        const activePointers = new Set<number>();

        const handleDown = (event: PointerEvent) => {
            if (event.pointerType !== 'touch') return;
            activePointers.add(event.pointerId);
            if (activePointers.size > 1) {
                // Multi-touch: abort any pending close gesture.
                active = false;
                primaryPointerId = null;
                return;
            }
            // Skip if the touch started on a button / link / input / slider
            // - the user is interacting with that element, not closing the
            // drawer.
            const target = event.target as Element | null;
            if (
                target?.closest?.(
                    'input, button, [role="slider"], [role="button"], [role="combobox"], select, textarea',
                )
            ) {
                return;
            }
            startX = event.clientX;
            startY = event.clientY;
            active = true;
            fired = false;
            primaryPointerId = event.pointerId;
        };

        const handleMove = (event: PointerEvent) => {
            if (!active || fired) return;
            if (primaryPointerId !== null && event.pointerId !== primaryPointerId) return;
            const dx = event.clientX - startX;
            const dy = Math.abs(event.clientY - startY);
            const signedDistance = direction === 'left' ? -dx : dx;
            // Reject mostly-vertical gestures (probably a scroll).
            if (dy > Math.abs(dx) * 1.4) {
                active = false;
                primaryPointerId = null;
                return;
            }
            if (signedDistance >= triggerPx) {
                fired = true;
                triggerHaptic('selection');
                onClose();
                active = false;
                primaryPointerId = null;
            }
        };

        const handleEnd = (event: PointerEvent) => {
            activePointers.delete(event.pointerId);
            if (primaryPointerId === null || event.pointerId === primaryPointerId) {
                active = false;
                primaryPointerId = null;
            }
        };

        el.addEventListener('pointerdown', handleDown, { passive: true });
        el.addEventListener('pointermove', handleMove, { passive: true });
        el.addEventListener('pointerup', handleEnd, { passive: true });
        el.addEventListener('pointercancel', handleEnd, { passive: true });

        return () => {
            el.removeEventListener('pointerdown', handleDown);
            el.removeEventListener('pointermove', handleMove);
            el.removeEventListener('pointerup', handleEnd);
            el.removeEventListener('pointercancel', handleEnd);
            activePointers.clear();
        };
    }, [direction, disabled, onClose, targetRef, triggerPx]);
};
