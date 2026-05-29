/**
 * Tiny module-scoped signal the mobile fullscreen player cover uses to tell
 * the player face's native touch listener "I own this gesture, don't claim
 * it as a vertical dismiss".
 *
 * Background: the album cover has Framer Motion's `drag="x"` for the
 * Spotify-style finger-tracking carousel. The parent .playerState has a
 * non-passive native touchmove listener that drives the swipe-down
 * dismiss. Both run in parallel for the same touch, with the parent
 * bailing out once it detects horizontal motion dominating. That
 * heuristic is fragile — a slow finger that pauses mid-drag, or a
 * straight-horizontal pull that the parent's tiny dy<4 dead-zone
 * silently keeps "active" through, can leave the parent in a state
 * where the next touchmove racks up `swipeY` and visibly fights the
 * cover.
 *
 * The cover toggles this flag synchronously inside Motion's onDragStart
 * / onDragEnd; the parent's touchstart consults it and skips the
 * dismiss gesture entirely while the cover is the gesture owner.
 *
 * The implementation is intentionally a module-scoped boolean, not a
 * React context: the touch listener is registered against a raw DOM
 * node and reads the flag during the synchronous browser event loop
 * — a context lookup would race the touch callback that needs the
 * value immediately.
 */
let dragging = false;

export const coverSwipeSignal = {
    /** Cover relinquished the gesture — parent can claim again. */
    end: (): void => {
        if (!dragging) return;
        dragging = false;
        console.info('[cover-swipe] end — parent dismiss re-enabled');
    },
    /** True while the cover's horizontal drag is in progress. */
    isDragging: (): boolean => dragging,
    /** Cover took the gesture; parent should stand down. */
    start: (): void => {
        if (dragging) return;
        dragging = true;
        console.info('[cover-swipe] start — parent dismiss suspended');
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
