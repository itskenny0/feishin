// Pure backoff + escape-hatch policy for the sync runner. Separated so the
// schedule math and the "can the user bail out yet?" decision are unit-tested
// without timers or React.

// Exponential backoff with a cap. Attempt 0 (the first retry after the first
// failure) waits BASE_MS; each subsequent attempt doubles, capped at MAX_MS.
const BASE_MS = 3_000;
const MAX_MS = 60_000;

// After this many CONSECUTIVE incomplete/failed full-sync attempts the
// "Continue anyway" escape hatch appears so a huge library / flaky server
// can't brick the app behind the gate forever.
export const ESCAPE_HATCH_AFTER_FAILURES = 3;

/**
 * Delay (ms) before retry attempt `failureCount` (1-indexed: the delay to wait
 * AFTER the Nth consecutive failure before the next attempt).
 */
export const backoffDelayMs = (failureCount: number): number => {
    if (failureCount <= 0) return 0;
    const ms = BASE_MS * 2 ** (failureCount - 1);
    return Math.min(MAX_MS, ms);
};

/**
 * Whether the escape hatch ("Continue anyway") should be offered given the
 * count of consecutive failed/incomplete attempts.
 */
export const canContinueAnyway = (failureCount: number): boolean =>
    failureCount >= ESCAPE_HATCH_AFTER_FAILURES;
