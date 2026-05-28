import { describe, expect, it } from 'vitest';

import {
    type CoverSwipeCommitInput,
    COVER_SWIPE_COMMIT_FRACTION,
    COVER_SWIPE_FLICK_VELOCITY_PX_PER_SEC,
    decideCoverSwipeCommit,
} from '/@/renderer/features/player/utils/cover-swipe-signal';

/**
 * Commit-decision regression coverage for the mobile fullscreen player
 * cover swipe. The album-art component routes (offset, velocity, queue
 * boundaries, radio, song-definedness) through decideCoverSwipeCommit.
 * We test the pure function instead of the component because the
 * component drags in the player store, item-image hook, remote-target
 * store and several other dependencies that are irrelevant to the rule
 * under test.
 *
 * The earlier polish pass was bitten by these edge cases:
 *   - Slow drags past 25% of cover width commit even with zero velocity.
 *   - High-velocity flicks commit on tiny displacement.
 *   - Queue boundaries (no prev / no next) snap back instead of firing
 *     a no-op mediaNext() that visibly slid-then-bounced the cover.
 *   - Radio mode disables commit entirely (no meaningful neighbours).
 *   - Reversals (big offset one way, sharp release velocity the other)
 *     pick the side the user can see, i.e. the offset.
 *   - Commit threshold scales with cover width so the same drag feels
 *     consistent across portrait + landscape.
 */
describe('decideCoverSwipeCommit', () => {
    const baseInput: CoverSwipeCommitInput = {
        coverWidth: 360,
        hasNext: true,
        hasPrevious: true,
        isRadioActive: false,
        isSongDefined: true,
        offsetX: 0,
        velocityX: 0,
    };

    it('snaps back on a tiny low-velocity nudge below the commit threshold', () => {
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: -10, velocityX: -50 })).toBe(
            'snap-back',
        );
    });

    it('commits next when the offset clears the commit threshold (slow drag, low velocity)', () => {
        // 25% of 360 = 90 - an offset of -100 is past the threshold.
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: -100, velocityX: -20 })).toBe(
            'next',
        );
    });

    it('commits prev when the offset clears the threshold rightward', () => {
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: 120, velocityX: 30 })).toBe(
            'previous',
        );
    });

    it('flick-commits next on tiny offset + high leftward velocity', () => {
        // 5 px offset is way under the 90 px commit threshold, but a
        // -800 px/s flick is past the 500 px/s flick threshold.
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: -5, velocityX: -800 })).toBe(
            'next',
        );
    });

    it('flick-commits prev on tiny offset + high rightward velocity', () => {
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: 5, velocityX: 800 })).toBe(
            'previous',
        );
    });

    it('does not flick-commit just below the velocity threshold', () => {
        const justBelow = COVER_SWIPE_FLICK_VELOCITY_PX_PER_SEC - 1;
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: -5, velocityX: -justBelow })).toBe(
            'snap-back',
        );
    });

    it('queue boundary: end of queue (no nextSong) snaps back even on a hard left flick', () => {
        // Pre-fix this called mediaNext() which the store no-oped, but
        // the cover still slid off and back - confusing UX.
        expect(
            decideCoverSwipeCommit({
                ...baseInput,
                hasNext: false,
                offsetX: -200,
                velocityX: -1500,
            }),
        ).toBe('snap-back');
    });

    it('queue boundary: start of queue (no previousSong) snaps back on a hard right flick', () => {
        expect(
            decideCoverSwipeCommit({
                ...baseInput,
                hasPrevious: false,
                offsetX: 200,
                velocityX: 1500,
            }),
        ).toBe('snap-back');
    });

    it('single-track queue (no neighbours) always snaps back', () => {
        const single = { ...baseInput, hasNext: false, hasPrevious: false };
        expect(decideCoverSwipeCommit({ ...single, offsetX: -250, velocityX: -1500 })).toBe(
            'snap-back',
        );
        expect(decideCoverSwipeCommit({ ...single, offsetX: 250, velocityX: 1500 })).toBe(
            'snap-back',
        );
    });

    it('radio mode (any state) disables commit even with a hard flick', () => {
        // The component's drag prop is also gated on !isRadioActive, but
        // belt-and-braces the decision rule must agree.
        expect(
            decideCoverSwipeCommit({
                ...baseInput,
                isRadioActive: true,
                offsetX: -200,
                velocityX: -1500,
            }),
        ).toBe('snap-back');
    });

    it('no current song: snaps back regardless of inputs', () => {
        expect(
            decideCoverSwipeCommit({
                ...baseInput,
                isSongDefined: false,
                offsetX: -200,
                velocityX: -1500,
            }),
        ).toBe('snap-back');
    });

    it('reversal at release: big left offset + sharp rightward velocity prefers offset (commits next)', () => {
        // The user dragged far left, then on release the finger was
        // already springing back. Offset is what they can see - pick it.
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: -150, velocityX: 1200 })).toBe(
            'next',
        );
    });

    it('reversal at release: big right offset + sharp leftward velocity prefers offset (commits prev)', () => {
        expect(decideCoverSwipeCommit({ ...baseInput, offsetX: 150, velocityX: -1200 })).toBe(
            'previous',
        );
    });

    it('scales the commit threshold with cover width (landscape vs portrait)', () => {
        // 25% of 800 = 200. A 150 px offset shouldn't commit on a wide
        // landscape cover.
        expect(decideCoverSwipeCommit({ ...baseInput, coverWidth: 800, offsetX: -150 })).toBe(
            'snap-back',
        );
        // ... but the same offset on a narrower cover commits.
        expect(decideCoverSwipeCommit({ ...baseInput, coverWidth: 300, offsetX: -150 })).toBe(
            'next',
        );
    });

    it('exposes a sane fraction constant (sanity-check magic number changes)', () => {
        // If someone bumps the fraction this test fails as a heads-up.
        expect(COVER_SWIPE_COMMIT_FRACTION).toBeGreaterThan(0.1);
        expect(COVER_SWIPE_COMMIT_FRACTION).toBeLessThan(0.5);
    });
});
