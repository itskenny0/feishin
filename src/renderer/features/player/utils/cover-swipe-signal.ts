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
