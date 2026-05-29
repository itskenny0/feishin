/**
 * Tiny shared flag that protects against MQTT re-emission loops.
 *
 * When the receiver applies an inbound command, the local player store
 * mutates, and any subscriber that turns store changes into outbound
 * state frames (currently none — but `publishOwnState` exists and a
 * follow-up sprint wires it to a store subscription) would publish that
 * change right back out. The peer that sent the original command would
 * then re-apply it (no-op, but the mirror flicks), and the bouncing
 * state-tick can collapse a controller's optimistic hold into staleness.
 *
 * The guard is a short-lived suppression window (200ms). Publishers
 * consult `isInboundApplyActive` before publishing — when it's true,
 * they skip the next publish. After 200ms the window closes and normal
 * publish behavior resumes. The window is bumped on every inbound
 * apply, so a rapid burst of inbound commands stays suppressed until
 * the burst itself ends.
 *
 * 200ms is well above the round-trip from store mutation → next subscribe
 * callback (sub-millisecond on a modern machine) and well below the
 * cadence at which a human would issue distinct commands, so a genuine
 * local action mid-burst is at worst delayed by the receiver-induced
 * change but never swallowed.
 */
const log = (...args: unknown[]) => console.info('[peer-sync]', ...args);

/** Suppression window in milliseconds. */
export const INBOUND_APPLY_WINDOW_MS = 200;

let suppressUntil = 0;

/**
 * Open the inbound-apply suppression window. Subsequent calls extend
 * the window to `now + INBOUND_APPLY_WINDOW_MS` so a burst of inbound
 * commands keeps the publisher quiet until the burst ends.
 */
export const markInboundApply = (now: number = Date.now()): void => {
    const wasActive = suppressUntil > now;
    suppressUntil = now + INBOUND_APPLY_WINDOW_MS;
    if (!wasActive) log('inbound apply window opened');
};

/**
 * Is the suppression window open right now? Publishers call this before
 * publishOwnState. Returning `true` means "skip this publish".
 */
export const isInboundApplyActive = (now: number = Date.now()): boolean => {
    return suppressUntil > now;
};

/** Reset for tests. */
export const __resetInboundApply = (): void => {
    suppressUntil = 0;
};
