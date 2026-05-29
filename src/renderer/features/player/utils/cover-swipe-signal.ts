/**
 * Single-owner gesture arbiter for the mobile fullscreen player.
 *
 * The album cover supports a Spotify-style horizontal swipe carousel, and
 * the player face supports a vertical pull-to-dismiss. Both gestures live on
 * the same touch surface, so exactly one of them must own any given touch.
 *
 * Why an arbiter and not the old one-way boolean: the cover used to claim
 * the gesture through Framer Motion's `drag="x"`, whose `onDragStart` fires
 * *asynchronously* once Motion's own movement threshold is crossed — which
 * is later than the parent's synchronous native `touchmove`. That timing gap
 * let the parent claim the vertical dismiss and `preventDefault()` the touch
 * before the cover had announced ownership, so both motion values moved at
 * once and the cover visibly "fought" the dismiss.
 *
 * The fix: both gestures now decide their axis synchronously inside native
 * `touchmove` listeners, and call this arbiter to claim. The cover's listener
 * is on an inner element, so by DOM bubble order it runs before the player
 * face's listener on every single move — making arbitration deterministic:
 *
 *   - horizontal-dominant move → cover calls `claimCover()` first; the face
 *     listener then sees `owner() === 'cover'` and stands down.
 *   - vertical-dominant move → the cover declines (doesn't claim); the face
 *     listener then calls `claimDismiss()` and drives the pull-to-dismiss.
 *
 * Once an owner is set it sticks for the rest of the touch; `release()` is
 * called on touchend / touchcancel (and defensively on a fresh single-finger
 * touchstart) to reset for the next gesture.
 *
 * Implemented as a module-scoped value, not React context: the touch
 * listeners are registered against raw DOM nodes and read/write the owner
 * synchronously inside the browser event loop — a context lookup would race
 * the event callback that needs the value immediately.
 */
export type CoverGestureOwner = 'cover' | 'dismiss' | 'none';

let owner: CoverGestureOwner = 'none';

const log = (...args: unknown[]) => console.info('[cover-swipe]', ...args);

export const coverGestureArbiter = {
    /**
     * Try to claim the touch for the cover's horizontal swipe. Succeeds
     * unless the dismiss gesture already owns it. Idempotent while owned by
     * the cover.
     */
    claimCover: (): boolean => {
        if (owner === 'dismiss') return false;
        if (owner !== 'cover') {
            owner = 'cover';
            log('cover claimed gesture — dismiss suspended');
        }
        return true;
    },
    /**
     * Try to claim the touch for the vertical pull-to-dismiss. Succeeds
     * unless the cover swipe already owns it. Idempotent while owned by
     * dismiss.
     */
    claimDismiss: (): boolean => {
        if (owner === 'cover') return false;
        if (owner !== 'dismiss') {
            owner = 'dismiss';
            log('dismiss claimed gesture — cover suspended');
        }
        return true;
    },
    /** Current gesture owner. */
    owner: (): CoverGestureOwner => owner,
    /** Reset for the next touch. */
    release: (): void => {
        if (owner === 'none') return;
        owner = 'none';
        log('gesture released');
    },
};

/**
 * Result of the cover-swipe commit decision. The album-art component
 * uses this to pick between firing mediaNext/mediaPrevious and
 * snapping the cover back to centre.
 *
 * Exposed as a pure helper rather than buried inside the component so
 * the gating rules (radio active, queue boundary, simultaneous
 * left/right signal at high velocity) get direct unit-test coverage
 * — the component itself is too dependency-heavy to render in tests.
 */
export type CoverSwipeCommit = 'next' | 'previous' | 'snap-back';

export interface CoverSwipeCommitInput {
    /** Width of the cover element. Commit threshold is 25% of this. */
    coverWidth: number;
    /** True iff there is a nextSong in the queue. */
    hasNext: boolean;
    /** True iff there is a previousSong in the queue. */
    hasPrevious: boolean;
    /** True if a radio stream is loaded (any state). Cover swipe is off. */
    isRadioActive: boolean;
    /** True iff the player has a current song. */
    isSongDefined: boolean;
    /** Horizontal offset (px) from drag start to release. */
    offsetX: number;
    /** Horizontal velocity (px/s) at release. */
    velocityX: number;
}

/** Minimum px/s flick that triggers commit even with tiny displacement. */
export const COVER_SWIPE_FLICK_VELOCITY_PX_PER_SEC = 500;
/** Fraction of cover width past which a slow drag commits. */
export const COVER_SWIPE_COMMIT_FRACTION = 0.25;

export const decideCoverSwipeCommit = (input: CoverSwipeCommitInput): CoverSwipeCommit => {
    const { coverWidth, hasNext, hasPrevious, isRadioActive, isSongDefined, offsetX, velocityX } =
        input;

    if (!isSongDefined || isRadioActive) {
        return 'snap-back';
    }

    const commitOffset = coverWidth * COVER_SWIPE_COMMIT_FRACTION;
    const wantsNextRaw =
        offsetX < -commitOffset || velocityX < -COVER_SWIPE_FLICK_VELOCITY_PX_PER_SEC;
    const wantsPrevRaw =
        offsetX > commitOffset || velocityX > COVER_SWIPE_FLICK_VELOCITY_PX_PER_SEC;

    // Conflict resolution: if both directions look committed (big left
    // offset but finger reversing at high right velocity on release),
    // the offset wins because that's what the user can see; velocity
    // is just a one-frame derivative at the release point.
    const wantsNext = wantsNextRaw && !(wantsPrevRaw && offsetX > 0);
    const wantsPrev = wantsPrevRaw && !(wantsNextRaw && offsetX < 0);

    if (wantsNext && hasNext) return 'next';
    if (wantsPrev && hasPrevious) return 'previous';
    return 'snap-back';
};
