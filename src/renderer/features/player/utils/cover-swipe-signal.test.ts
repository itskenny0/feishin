import { afterEach, describe, expect, it, vi } from 'vitest';

import { coverGestureArbiter } from '/@/renderer/features/player/utils/cover-swipe-signal';

/**
 * Regression coverage for the mobile fullscreen player cover swipe vs
 * pull-to-dismiss arbitration.
 *
 * The bug: the cover's horizontal swipe and the player face's vertical
 * dismiss fought for the same touch, leaving the cover stuck mid-drag
 * until the app was reloaded. The original cause was timing — Motion's
 * `drag="x"` announced ownership asynchronously, after the face's
 * synchronous touchmove had already claimed the dismiss.
 *
 * The fix: a single-owner arbiter that both gestures claim synchronously
 * inside their native touchmove listeners. Because the cover's listener is
 * on an inner element it runs first in bubble order, so whichever axis
 * dominates the first real move claims, and the other side stands down for
 * the rest of the touch. These tests lock the arbiter's contract: claims
 * are exclusive, idempotent, and reset cleanly across gestures.
 */
describe('coverGestureArbiter', () => {
    afterEach(() => {
        // Belt-and-braces: reset so a missed release() can't poison the
        // next test (and surfaces the bug in CI).
        coverGestureArbiter.release();
        vi.restoreAllMocks();
    });

    it('starts with no owner (cold load)', () => {
        expect(coverGestureArbiter.owner()).toBe('none');
    });

    it('claimCover takes ownership and claimDismiss is then refused', () => {
        expect(coverGestureArbiter.claimCover()).toBe(true);
        expect(coverGestureArbiter.owner()).toBe('cover');
        // Dismiss cannot steal a touch the cover already owns.
        expect(coverGestureArbiter.claimDismiss()).toBe(false);
        expect(coverGestureArbiter.owner()).toBe('cover');
    });

    it('claimDismiss takes ownership and claimCover is then refused', () => {
        expect(coverGestureArbiter.claimDismiss()).toBe(true);
        expect(coverGestureArbiter.owner()).toBe('dismiss');
        expect(coverGestureArbiter.claimCover()).toBe(false);
        expect(coverGestureArbiter.owner()).toBe('dismiss');
    });

    it('claims are idempotent and log exactly once per gesture', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        expect(coverGestureArbiter.claimCover()).toBe(true);
        expect(coverGestureArbiter.claimCover()).toBe(true);
        expect(coverGestureArbiter.claimCover()).toBe(true);

        const claimLogs = info.mock.calls.filter((args) =>
            args.map(String).join(' ').includes('cover claimed'),
        );
        expect(claimLogs).toHaveLength(1);
        expect(coverGestureArbiter.owner()).toBe('cover');
    });

    it('release() while idle is a no-op (no stray log)', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        coverGestureArbiter.release();
        coverGestureArbiter.release();

        const releaseLogs = info.mock.calls.filter((args) =>
            args.map(String).join(' ').includes('gesture released'),
        );
        expect(releaseLogs).toHaveLength(0);
        expect(coverGestureArbiter.owner()).toBe('none');
    });

    it('resets across consecutive gestures (the actual stability regression)', () => {
        // First gesture: cover owns, then releases.
        coverGestureArbiter.claimCover();
        coverGestureArbiter.release();
        expect(coverGestureArbiter.owner()).toBe('none');

        // Second gesture must read clean — a dismiss can now claim. Pre-fix
        // a leaked owner made the next dismiss attempt silently swallowed.
        expect(coverGestureArbiter.claimDismiss()).toBe(true);
        expect(coverGestureArbiter.owner()).toBe('dismiss');
        coverGestureArbiter.release();
        expect(coverGestureArbiter.owner()).toBe('none');
    });
});
