import { act, cleanup, render } from '@testing-library/react';
import { useEffect, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { coverGestureArbiter } from '/@/renderer/features/player/utils/cover-swipe-signal';

/**
 * Regression coverage for the mobile fullscreen player cover swipe vs
 * the player face's swipe-down dismiss.
 *
 * The bug: the horizontal cover swipe and the vertical dismiss both run for
 * the same touch. The original implementation used Framer Motion's
 * `drag="x"`, which announced ownership asynchronously — *after* the face's
 * synchronous touchmove had already claimed the dismiss — so both gestures
 * drove their motion values at once and the cover fought the dismiss.
 *
 * The fix: both gestures decide their axis synchronously inside native
 * touchmove listeners and claim a single-owner `coverGestureArbiter`. The
 * cover's listener is on an inner element, so by DOM bubble order it runs
 * before the face's listener on every move — making arbitration
 * deterministic on the *same* event, with no async gap to lose.
 *
 * This harness mirrors the real listeners (cover nested inside the face,
 * both consulting the arbiter) so a regression in either side surfaces as a
 * failing test rather than a UI bug. Touch events are dispatched on the
 * inner cover element and bubble to the face, reproducing the exact event
 * ordering the production code relies on.
 */

interface HarnessProps {
    onDismissOffset?: (offset: number) => void;
    swipeXReportRef?: { current: number };
}

function GestureHarness({ onDismissOffset, swipeXReportRef }: HarnessProps) {
    const faceRef = useRef<HTMLDivElement | null>(null);
    const coverRef = useRef<HTMLDivElement | null>(null);

    // --- Cover listener (inner element, runs first) -----------------------
    useEffect(() => {
        const el = coverRef.current;
        if (!el) return undefined;
        let startX = 0;
        let startY = 0;
        let axis: 'declined' | 'none' | 'x' = 'none';

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 1) coverGestureArbiter.release();
            const touch = e.touches[0];
            if (!touch) return;
            startX = touch.clientX;
            startY = touch.clientY;
            axis = 'none';
        };
        const onTouchMove = (e: TouchEvent) => {
            if (coverGestureArbiter.owner() === 'dismiss') {
                axis = 'declined';
                return;
            }
            if (axis === 'declined') return;
            const touch = e.touches[0];
            if (!touch) return;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (axis === 'none') {
                const adx = Math.abs(dx);
                const ady = Math.abs(dy);
                if (adx < 4 && ady < 4) return;
                if (adx > ady && coverGestureArbiter.claimCover()) {
                    axis = 'x';
                } else {
                    axis = 'declined';
                    return;
                }
            }
            if (swipeXReportRef) swipeXReportRef.current = dx;
        };
        const onTouchEnd = () => {
            axis = 'none';
            coverGestureArbiter.release();
        };
        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
        };
    }, [swipeXReportRef]);

    // --- Face listener (ancestor element, runs second) --------------------
    useEffect(() => {
        const el = faceRef.current;
        if (!el) return undefined;
        let startY = 0;
        let active = false;
        let claimed = false;

        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 1) coverGestureArbiter.release();
            const touch = e.touches[0];
            if (!touch) return;
            startY = touch.clientY;
            active = true;
            claimed = false;
        };
        const onTouchMove = (e: TouchEvent) => {
            if (!active) return;
            if (coverGestureArbiter.owner() === 'cover') {
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
                if (!coverGestureArbiter.claimDismiss()) {
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
            if (coverGestureArbiter.owner() === 'dismiss') coverGestureArbiter.release();
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
            <div
                data-cover-swipe
                data-testid="cover"
                ref={coverRef}
                style={{ height: 320, width: 320 }}
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
    changedTouches: [{ clientX, clientY, identifier: 0 } as unknown as Touch],
    touches: [{ clientX, clientY, identifier: 0 } as unknown as Touch],
});

const dispatchTouch = (target: Element, type: string, x: number, y: number) => {
    const event = new TouchEvent(type, makeTouchInit(x, y));
    target.dispatchEvent(event);
};

const hasTouchEvent = typeof window !== 'undefined' && typeof window.TouchEvent !== 'undefined';

afterEach(() => {
    cleanup();
    coverGestureArbiter.release();
    vi.restoreAllMocks();
});

describe.runIf(hasTouchEvent)('mobile fullscreen player cover-swipe vs dismiss routing', () => {
    it('a vertical pull on the cover is owned by the face dismiss (cover declines)', () => {
        const dismissOffsets: number[] = [];
        const { getByTestId } = render(
            <GestureHarness onDismissOffset={(o) => dismissOffsets.push(o)} />,
        );
        const cover = getByTestId('cover');

        act(() => {
            dispatchTouch(cover, 'touchstart', 200, 100);
            dispatchTouch(cover, 'touchmove', 200, 150);
            dispatchTouch(cover, 'touchmove', 200, 220);
        });

        expect(coverGestureArbiter.owner()).toBe('dismiss');
        expect(dismissOffsets.length).toBeGreaterThan(0);
        expect(dismissOffsets.at(-1)).toBeGreaterThan(0);
    });

    it('a horizontal pull on the cover is owned by the cover (face stands down)', () => {
        const dismissOffsets: number[] = [];
        const swipeXReportRef = { current: 0 };
        const { getByTestId } = render(
            <GestureHarness
                onDismissOffset={(o) => dismissOffsets.push(o)}
                swipeXReportRef={swipeXReportRef}
            />,
        );
        const cover = getByTestId('cover');

        act(() => {
            dispatchTouch(cover, 'touchstart', 200, 100);
            dispatchTouch(cover, 'touchmove', 260, 105);
            dispatchTouch(cover, 'touchmove', 300, 108);
        });

        // The cover claimed on the same move the face also saw; deterministic
        // inner-first ordering means the face never accumulated an offset.
        expect(coverGestureArbiter.owner()).toBe('cover');
        expect(dismissOffsets).toEqual([]);
        expect(swipeXReportRef.current).toBeGreaterThan(0);
    });

    it('a near-diagonal tie defers to the dismiss (cover only claims strict horizontal dominance)', () => {
        const dismissOffsets: number[] = [];
        const { getByTestId } = render(
            <GestureHarness onDismissOffset={(o) => dismissOffsets.push(o)} />,
        );
        const cover = getByTestId('cover');

        act(() => {
            dispatchTouch(cover, 'touchstart', 200, 100);
            // dx === dy → cover does not claim (needs adx > ady); face claims.
            dispatchTouch(cover, 'touchmove', 230, 130);
        });

        expect(coverGestureArbiter.owner()).toBe('dismiss');
        expect(dismissOffsets.length).toBeGreaterThan(0);
    });

    it('a second gesture after release routes cleanly (the "restart the app" case)', () => {
        const dismissOffsets: number[] = [];
        const swipeXReportRef = { current: 0 };
        const { getByTestId } = render(
            <GestureHarness
                onDismissOffset={(o) => dismissOffsets.push(o)}
                swipeXReportRef={swipeXReportRef}
            />,
        );
        const cover = getByTestId('cover');

        // First touch: cover claims a horizontal swipe, then ends.
        act(() => {
            dispatchTouch(cover, 'touchstart', 200, 100);
            dispatchTouch(cover, 'touchmove', 280, 104);
            dispatchTouch(cover, 'touchend', 280, 104);
        });
        expect(dismissOffsets).toEqual([]);
        expect(coverGestureArbiter.owner()).toBe('none');

        // Second touch: a vertical pull the face should now pick up — pre-fix
        // a leaked owner left this inert.
        act(() => {
            dispatchTouch(cover, 'touchstart', 200, 100);
            dispatchTouch(cover, 'touchmove', 200, 200);
        });
        expect(coverGestureArbiter.owner()).toBe('dismiss');
        expect(dismissOffsets.length).toBeGreaterThan(0);
    });
});
