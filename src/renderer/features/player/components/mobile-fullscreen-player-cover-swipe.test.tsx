import { act, cleanup, render } from '@testing-library/react';
import { animate, motion, useMotionValue } from 'motion/react';
import { useCallback, useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coverSwipeSignal } from '/@/renderer/features/player/utils/cover-swipe-signal';

/**
 * Regression coverage for the mobile fullscreen player cover swipe vs
 * the player face's swipe-down dismiss.
 *
 * The bug: vertical-dismiss touch listener on .playerState and the
 * horizontal cover-drag both run for the same touch. Without an
 * explicit cross-talk signal, the dismiss listener can claim the
 * gesture, leaving the cover stuck under the finger until reload.
 *
 * The fix: cover toggles coverSwipeSignal in onDragStart / onDragEnd;
 * the dismiss listener consults coverSwipeSignal.isDragging() and
 * bails immediately when true.
 *
 * These tests don't render the full mobile player (too many heavy
 * dependencies — stores, queue, item-image hook, settings). They wire
 * up the same gesture-routing rules in a minimal harness so the
 * behaviour can be locked down independently.
 */

interface HarnessProps {
    onDismissOffset?: (offset: number) => void;
    swipeXReportRef?: { current: number };
}

/**
 * Minimal model of MobileFullscreenPlayer's gesture routing:
 *
 * - .face: native non-passive touchmove listener owns the vertical
 *   dismiss drag (writes to onDismissOffset for the test to inspect).
 * - .cover: Framer-Motion `drag="x"` motion.div with onDragStart /
 *   onDragEnd hooked through coverSwipeSignal.
 *
 * Both are siblings in the same scrollable surface. The listener
 * registered against .face is the exact bail-out pattern used in
 * mobile-fullscreen-player.tsx — extracted here so a regression in
 * either side surfaces as a failing test rather than a UI bug.
 */
function GestureHarness({ onDismissOffset, swipeXReportRef }: HarnessProps) {
    const faceRef = useRef<HTMLDivElement | null>(null);
    const swipeX = useMotionValue(0);

    // Mirror the cover's drag-start/end into coverSwipeSignal, exactly
    // the way mobile-fullscreen-player-album-art.tsx does it.
    const onDragStart = useCallback(() => {
        coverSwipeSignal.start();
    }, []);
    const onDragEnd = useCallback(() => {
        coverSwipeSignal.end();
        // Settle the spring back to 0 with the same animate() call the
        // real component uses so we exercise the cancel-stale-anim path.
        animate(swipeX, 0, { duration: 0.05 });
    }, [swipeX]);

    useEffect(() => {
        if (swipeXReportRef) {
            return swipeX.on('change', (v) => {
                swipeXReportRef.current = v;
            });
        }
        return undefined;
    }, [swipeX, swipeXReportRef]);

    useEffect(() => {
        const el = faceRef.current;
        if (!el) return undefined;

        let startY = 0;
        let active = false;
        let claimed = false;

        const onTouchStart = (e: TouchEvent) => {
            const touch = e.touches[0];
            if (!touch) return;
            startY = touch.clientY;
            active = true;
            claimed = false;
        };

        const onTouchMove = (e: TouchEvent) => {
            if (!active) return;
            // The bail-out under test. If the cover claimed the gesture,
            // the dismiss listener stands down for the rest of the
            // touch — even if subsequent touchmove samples look
            // vertical-enough to satisfy the claim heuristic.
            if (coverSwipeSignal.isDragging()) {
                active = false;
                return;
            }
            const touch = e.touches[0];
            if (!touch) return;
            const dy = touch.clientY - startY;
            if (!claimed) {
                if (Math.abs(dy) < 4) return;
                if (dy < 0) {
                    active = false;
                    return;
                }
                claimed = true;
            }
            onDismissOffset?.(Math.max(0, dy * 0.75));
        };

        const onTouchEnd = () => {
            active = false;
            claimed = false;
        };

        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
        };
    }, [onDismissOffset]);

    return (
        <div data-testid="face" ref={faceRef} style={{ height: 800, width: 400 }}>
            <motion.div
                data-cover-swipe
                data-testid="cover"
                drag="x"
                dragConstraints={{ left: 0, right: 0 }}
                onDragEnd={onDragEnd}
                onDragStart={onDragStart}
                style={{ height: 320, width: 320, x: swipeX }}
            />
        </div>
    );
}

const makeTouchInit = (clientX: number, clientY: number): TouchEventInit => ({
    bubbles: true,
    cancelable: true,
    // jsdom doesn't ship the Touch constructor, but TouchEvent reads
    // touches/changedTouches as ordinary arrays so a plain object with
    // the fields the listener uses is enough.
    changedTouches: [{ clientX, clientY } as unknown as Touch],
    touches: [{ clientX, clientY } as unknown as Touch],
});

const dispatchTouch = (target: Element, type: string, x: number, y: number) => {
    const event = new TouchEvent(type, makeTouchInit(x, y));
    target.dispatchEvent(event);
};

const hasTouchEvent = typeof window !== 'undefined' && typeof window.TouchEvent !== 'undefined';

afterEach(() => {
    cleanup();
    coverSwipeSignal.end();
    vi.restoreAllMocks();
});

describe.runIf(hasTouchEvent)('mobile fullscreen player cover-swipe vs dismiss routing', () => {
    it('the face listener still drives swipeY when the cover has not claimed', () => {
        const dismissOffsets: number[] = [];
        const { getByTestId } = render(
            <GestureHarness onDismissOffset={(o) => dismissOffsets.push(o)} />,
        );
        const face = getByTestId('face');

        act(() => {
            dispatchTouch(face, 'touchstart', 200, 100);
            dispatchTouch(face, 'touchmove', 200, 150);
            dispatchTouch(face, 'touchmove', 200, 220);
        });

        // Vertical pull was claimed and a positive swipeY was emitted.
        expect(dismissOffsets.length).toBeGreaterThan(0);
        expect(dismissOffsets.at(-1)).toBeGreaterThan(0);
    });

    it('the face listener stops accumulating dismiss offsets once the cover claims the gesture', () => {
        const dismissOffsets: number[] = [];
        const { getByTestId } = render(
            <GestureHarness onDismissOffset={(o) => dismissOffsets.push(o)} />,
        );
        const face = getByTestId('face');

        act(() => {
            dispatchTouch(face, 'touchstart', 200, 100);
            // Cover's drag-start fires before the first touchmove the
            // face would have used to "claim" the dismiss — mirrors
            // Motion's onDragStart firing on the first move past its
            // own threshold.
            coverSwipeSignal.start();
            dispatchTouch(face, 'touchmove', 200, 200);
            dispatchTouch(face, 'touchmove', 200, 260);
        });

        // The dismiss listener stood down — no offsets accumulated even
        // though the touch was vertically large enough to qualify.
        expect(dismissOffsets).toEqual([]);
    });

    it('a second gesture after end() routes cleanly (the "restart the app" case)', () => {
        const dismissOffsets: number[] = [];
        const { getByTestId } = render(
            <GestureHarness onDismissOffset={(o) => dismissOffsets.push(o)} />,
        );
        const face = getByTestId('face');

        // First touch: cover claims, then ends cleanly.
        act(() => {
            dispatchTouch(face, 'touchstart', 200, 100);
            coverSwipeSignal.start();
            dispatchTouch(face, 'touchmove', 200, 200);
            coverSwipeSignal.end();
            dispatchTouch(face, 'touchend', 200, 200);
        });
        expect(dismissOffsets).toEqual([]);

        // Second touch: a vertical pull that the dismiss listener
        // should pick up because the cover signalled it had let go.
        // Pre-fix this stayed inert because dragging never cleared.
        act(() => {
            dispatchTouch(face, 'touchstart', 200, 100);
            dispatchTouch(face, 'touchmove', 200, 200);
        });
        expect(dismissOffsets.length).toBeGreaterThan(0);
    });
});
