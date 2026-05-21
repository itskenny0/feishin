import { useCallback, useRef } from 'react';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';

/**
 * Long-press detector that synthesises a context-menu-shaped event for
 * touch surfaces.
 *
 * On Android the WebView usually fires `contextmenu` on long-press by
 * itself — but only on text-selectable areas, and only outside
 * `touch-action: manipulation` ancestors. For our list rows that's
 * unreliable, so this hook explicitly arms a 500ms timer on pointerdown
 * and fires the callback if the user hasn't moved more than ~10px or
 * lifted the pointer in that window. Cancels cleanly on scroll, drag,
 * or pointerup so it never misfires during normal flicks.
 *
 * Hook returns pointerdown/move/up/cancel handlers ready to spread onto
 * the target element. The downstream callback receives the original
 * PointerEvent (its clientX/clientY are the right anchor for the menu)
 * — call sites can cast to React.MouseEvent if their menu API expects
 * that shape; PointerEvent extends MouseEvent so the coordinates and
 * preventDefault/stopPropagation surface line up.
 */

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

interface UseLongPressOptions {
    /** Set true to disable handling entirely (e.g. on desktop). */
    disabled?: boolean;
    /** Called when the user has pressed for {@link LONG_PRESS_MS} without moving. */
    onLongPress: (event: React.PointerEvent<HTMLElement>) => void;
    /** Optional regular click — fires on pointerup if no long-press happened. */
    onPress?: (event: React.PointerEvent<HTMLElement>) => void;
}

export const useLongPress = ({ disabled, onLongPress, onPress }: UseLongPressOptions) => {
    const timer = useRef<null | number>(null);
    const startPos = useRef<null | { x: number; y: number }>(null);
    const longPressed = useRef(false);
    // Track whether the most recent pointer interaction completed as a
    // long-press. Used by the onClickCapture handler to swallow the
    // browser-synthesised click that always fires after pointerup -
    // without this the row's onClick would also fire on long-press,
    // adding the song to queue + opening the context menu in one tap.
    const suppressNextClick = useRef(false);

    const clear = useCallback(() => {
        if (timer.current !== null) {
            window.clearTimeout(timer.current);
            timer.current = null;
        }
        startPos.current = null;
    }, []);

    const onPointerDown = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (disabled) return;
            // Only react to touch-shaped events; mouse keeps using the
            // browser's native right-click → contextmenu pipeline so we
            // don't double-fire.
            if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;

            longPressed.current = false;
            startPos.current = { x: event.clientX, y: event.clientY };
            // Snapshot the event for the timer — React's event pool
            // recycles synthetic events, so we persist the raw fields
            // via a closure copy rather than holding onto the React
            // event reference.
            const persisted = event;

            timer.current = window.setTimeout(() => {
                longPressed.current = true;
                suppressNextClick.current = true;
                triggerHaptic('impact');
                onLongPress(persisted);
            }, LONG_PRESS_MS);
        },
        [disabled, onLongPress],
    );

    const onPointerMove = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (!startPos.current || timer.current === null) return;
            const dx = Math.abs(event.clientX - startPos.current.x);
            const dy = Math.abs(event.clientY - startPos.current.y);
            // Any meaningful movement cancels the long-press — scrolls
            // and accidental drifts shouldn't pop the context menu.
            if (dx > MOVE_TOLERANCE_PX || dy > MOVE_TOLERANCE_PX) clear();
        },
        [clear],
    );

    const onPointerUp = useCallback(
        (event: React.PointerEvent<HTMLElement>) => {
            if (timer.current !== null && !longPressed.current && onPress) {
                onPress(event);
            }
            clear();
        },
        [clear, onPress],
    );

    const onPointerCancel = useCallback(() => {
        clear();
    }, [clear]);

    // Capture-phase click handler that swallows the click immediately
    // after a long-press fire. Capture phase is essential — by the time
    // bubble phase reaches sibling/parent onClick handlers, we've
    // already stopped propagation here.
    const onClickCapture = useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (suppressNextClick.current) {
            suppressNextClick.current = false;
            event.preventDefault();
            event.stopPropagation();
        }
    }, []);

    return { onClickCapture, onPointerCancel, onPointerDown, onPointerMove, onPointerUp };
};
