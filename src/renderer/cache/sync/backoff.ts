// Adaptive backoff controller for the thumbnail pre-cache sweep.
//
// The sweep against a slow phone-hosted Jellyfin "starts fast then crawls
// after ~2000 items": the previous design HALVED effective concurrency on a
// rolling slow window but recovered only +1 per fast item, so once a slow
// patch floored the cap near 1 it could take hundreds of items (or, after a
// sustained slow stretch, effectively never) to climb back to the ceiling.
//
// This controller makes the response SYMMETRIC: multiplicative DOWN on
// overload (halve), multiplicative UP on recovery (double after K consecutive
// fast items). It is a pure object — no I/O, no module side effects — so the
// ramp is unit-testable without standing up the whole worker pool (and so its
// test doesn't drag the heavy sweep module's imports into the suite).

export interface BackoffConfig {
    ceiling: number; // configured concurrency ceiling
    fastItemMs: number; // an item under this is "fast"
    floor: number; // never drop below this (>= 1)
    pauseMs: number; // dispatch pause after a back-off
    recoverStreak: number; // consecutive fast items before doubling the cap
    thresholdMs: number; // rolling avg over this triggers a back-off
    window: number; // rolling latency window length
}

export interface BackoffController {
    /** Current effective concurrency cap. */
    cap: number;
    /** Rolling latency average over the current window (0 until the window fills). */
    recentAvgMs: () => number;
    /**
     * Record a completed item. `transient` outcomes (instant server rejects)
     * never count toward the fast-recovery streak — only genuine fast
     * successes should be read as "the server is healthy, ramp up". Returns
     * the desired post-item action: 'backoff' (caller should pause pauseMs),
     * 'rampup', or 'none'.
     */
    record: (
        latencyMs: number,
        isTransient: boolean,
        nowMs: number,
    ) => 'backoff' | 'none' | 'rampup';
}

export const createBackoffController = (cfg: BackoffConfig): BackoffController => {
    const latency: number[] = [];
    let consecutiveFast = 0;
    let lastBackoffAt = 0;
    const ctrl: BackoffController = {
        cap: cfg.ceiling,
        recentAvgMs() {
            if (latency.length === 0) return 0;
            return Math.round(latency.reduce((a, b) => a + b, 0) / latency.length);
        },
        record(latencyMs, isTransient, nowMs) {
            latency.push(latencyMs);
            if (latency.length > cfg.window) latency.shift();

            if (!isTransient && latencyMs < cfg.fastItemMs) consecutiveFast += 1;
            else consecutiveFast = 0;

            const avg =
                latency.length >= cfg.window
                    ? latency.reduce((a, b) => a + b, 0) / latency.length
                    : 0;

            // Overload: halve and pause. Rate-limited so a single window can't
            // trigger repeated halvings on every subsequent item.
            if (
                latency.length >= cfg.window &&
                avg > cfg.thresholdMs &&
                nowMs - lastBackoffAt > cfg.pauseMs * 2
            ) {
                lastBackoffAt = nowMs;
                ctrl.cap = Math.max(cfg.floor, Math.floor(ctrl.cap / 2));
                consecutiveFast = 0;
                latency.length = 0;
                return 'backoff';
            }

            // Recovery: double after a streak of fast items.
            if (ctrl.cap < cfg.ceiling && consecutiveFast >= cfg.recoverStreak) {
                consecutiveFast = 0;
                ctrl.cap = Math.min(cfg.ceiling, ctrl.cap * 2);
                return 'rampup';
            }
            return 'none';
        },
    };
    return ctrl;
};
