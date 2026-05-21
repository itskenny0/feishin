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
    /**
     * Fired with the current x-delta while the finger is moving. Use this to
     * translate the underlying content with the finger so the swipe feels
     * tactile (Spotify's mini-player pattern). The hook hands you the raw
     * dx in pixels; clamp / dampen / scale as needed at the call site.
     *
     * Fires with `dx = 0` when the pointer hasn't moved past the dead-zone
     * yet and when the swipe is cancelled (vertical drift / pointer
     * release without crossing the trigger), so the caller can animate
     * the content back to rest.
     */
    onSwipeMove?: (dx: number) => void;
    onSwipeRight?: () => void;
    triggerPx?: number;
}

export const useHorizontalSwipe = ({
    disabled,
    onSwipeLeft,
    onSwipeMove,
    onSwipeRight,
    triggerPx = 60,
}: UseHorizontalSwipeOptions) => {
    const startRef = useRef<null | { x: number; y: number }>(null);
    const firedRef = useRef(false);
    // Suppress the browser-synthesised click that follows the pointerup
    // when a swipe fired — otherwise a swipe-to-next on the mini-player
    // would ALSO fire the wrapper's onClick (e.g. expand-to-fullscreen).
    const suppressNextClick = useRef(false);

    const onPointerDown = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (disabled) return;
            // Allow touch + pen + 'mouse' pointer types. Capacitor 8's
            // Android WebView sometimes reports pointerType='mouse' on
            // actual touch interactions (depending on the Android
            // version's input synthesis), so a strict 'touch' filter
            // would silently kill the gesture there. The triggerPx
            // movement threshold + bail-on-vertical-drift already
            // filter out accidental click drift, so allowing every
            // pointer type is safe.
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
                onSwipeMove?.(0);
                return;
            }
            // Stream the dx to the caller so the underlying content can
            // track the finger. Fires every pointermove that has more
            // horizontal than vertical drift; the consumer can decide
            // whether to apply rubber-banding once dx exceeds triggerPx.
            onSwipeMove?.(dx);
            if (Math.abs(dx) >= triggerPx) {
                firedRef.current = true;
                suppressNextClick.current = true;
                triggerHaptic('selection');
                if (dx < 0) {
                    onSwipeLeft?.();
                } else {
                    onSwipeRight?.();
                }
                startRef.current = null;
                // Reset the move so the consumer animates back to rest
                // after we've fired the threshold crossing event.
                onSwipeMove?.(0);
            }
        },
        [onSwipeLeft, onSwipeMove, onSwipeRight, triggerPx],
    );

    const onPointerUp = useCallback(() => {
        if (startRef.current) {
            onSwipeMove?.(0);
        }
        startRef.current = null;
    }, [onSwipeMove]);

    const onPointerCancel = useCallback(() => {
        if (startRef.current) {
            onSwipeMove?.(0);
        }
        startRef.current = null;
    }, [onSwipeMove]);

    // Capture-phase click handler that swallows the click immediately
    // after a swipe fires. Capture phase matters — by bubble phase
    // sibling/parent onClick handlers would have already run.
    const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (suppressNextClick.current) {
            suppressNextClick.current = false;
            event.preventDefault();
            event.stopPropagation();
        }
    }, []);

    return { onClickCapture, onPointerCancel, onPointerDown, onPointerMove, onPointerUp };
};
