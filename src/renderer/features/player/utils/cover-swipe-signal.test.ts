import { afterEach, describe, expect, it, vi } from 'vitest';

import { coverSwipeSignal } from '/@/renderer/features/player/utils/cover-swipe-signal';

/**
 * Regression coverage for the mobile fullscreen player cover swipe.
 *
 * The bug: the cover's horizontal Framer-Motion drag and the parent
 * .playerState's native touchmove dismiss listener fight for the same
 * touch, leaving the cover stuck mid-drag until the app is reloaded.
 *
 * The fix: the cover calls coverSwipeSignal.start() inside Motion's
 * onDragStart and the parent's touchmove bails out the instant
 * coverSwipeSignal.isDragging() flips true. This module owns that
 * tiny shared bit of state, so its semantics need to hold up: the
 * flag must be cheap to read, idempotent on duplicate start()/end()
 * pairs, and reset across consecutive gestures so the next swipe is
 * not silently treated as a continuation of the previous one.
 */
describe('coverSwipeSignal', () => {
    afterEach(() => {
        // Belt-and-braces: every test resets the flag so a missed end()
        // can't poison the next test (and surfaces the bug in CI).
        coverSwipeSignal.end();
        vi.restoreAllMocks();
    });

    it('starts inert (no cover drag in progress on cold load)', () => {
        expect(coverSwipeSignal.isDragging()).toBe(false);
    });

    it('flips dragging true on start() and back to false on end()', () => {
        coverSwipeSignal.start();
        expect(coverSwipeSignal.isDragging()).toBe(true);

        coverSwipeSignal.end();
        expect(coverSwipeSignal.isDragging()).toBe(false);
    });

    it('treats repeated start() calls as a no-op (single dispatcher logs once per gesture)', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        coverSwipeSignal.start();
        coverSwipeSignal.start();
        coverSwipeSignal.start();

        // Lifecycle log fires exactly once per real gesture start.
        const startLogs = info.mock.calls.filter(([msg]) =>
            String(msg).includes('[cover-swipe] start'),
        );
        expect(startLogs).toHaveLength(1);
        expect(coverSwipeSignal.isDragging()).toBe(true);
    });

    it('treats end() while inert as a no-op (no stray "end" log when the gesture never started)', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        coverSwipeSignal.end();
        coverSwipeSignal.end();

        const endLogs = info.mock.calls.filter(([msg]) =>
            String(msg).includes('[cover-swipe] end'),
        );
        expect(endLogs).toHaveLength(0);
        expect(coverSwipeSignal.isDragging()).toBe(false);
    });

    it('resets across consecutive gestures (the actual stability regression)', () => {
        // First swipe: starts, ends.
        coverSwipeSignal.start();
        coverSwipeSignal.end();
        expect(coverSwipeSignal.isDragging()).toBe(false);

        // Second swipe must read as a clean start, not a poisoned
        // carry-over. This is exactly the path the "had to restart the
        // app" bug exposes: if end() leaked dragging=true, the parent
        // listener would treat the next dismiss attempt as the cover
        // owning the gesture and silently swallow it.
        coverSwipeSignal.start();
        expect(coverSwipeSignal.isDragging()).toBe(true);
        coverSwipeSignal.end();
        expect(coverSwipeSignal.isDragging()).toBe(false);
    });
});
