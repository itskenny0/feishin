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
    // Clamp each non-transient sample to this many ms before it enters the
    // rolling window. A backgrounded/dozed Android WebView freezes the sweep's
    // awaits while the wall clock keeps running, so a single item can measure
    // minutes (observed: 22-min "items"); left unclamped one such sample
    // dominates the window average and instantly floors the cap. Unset =
    // no clamp (legacy behaviour).
    clampMs?: number;
    fastItemMs: number; // an item under this is "fast"
    floor: number; // never drop below this (>= 1)
    pauseMs: number; // dispatch pause after a back-off
    recoverStreak: number; // consecutive fast items before doubling the cap
    thresholdMs: number; // rolling avg over this triggers a back-off
    // Unconditional time-based ramp-up. If at least this many ms elapse since
    // the last cap change without a back-off, AND the cap is below the ceiling,
    // AND the most recent item was a genuine (non-transient) completion, step
    // the cap up regardless of per-item latency. This is what lets the cap
    // escape the floor when steady-state items are slow-but-healthy (e.g. 3-8s
    // LAN fetches that are neither "fast" — under fastItemMs — nor an overload
    // signal). Without it, recovery requires items under fastItemMs, which a
    // slow server never produces, so the cap stays pinned at the floor forever.
    // Unset = disabled (legacy behaviour).
    timeRampMs?: number;
    window: number; // rolling latency window length
}

export interface BackoffController {
    /** Current effective concurrency cap. */
    cap: number;
    /**
     * Force an immediate halving of the cap (the SAME math as the latency
     * overload branch) WITHOUT a latency sample. Used by the 404-storm
     * load-shed throttle: a silently load-shedding server returns INSTANT
     * 404s, so the latency-driven overload path never fires (the samples look
     * "fast"), yet the pool must still shrink so the post-cooldown resume is
     * gentle enough that the slow server serves 200s instead of re-shedding.
     * Honors the configured floor and resets the recovery streak exactly like a
     * latency back-off, so the normal recovery/time-ramp path climbs it back up
     * once the server starts serving real covers again.
     */
    forceBackoff: (nowMs: number) => void;
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
    // Timestamp of the last cap change (back-off OR ramp-up). The time-based
    // ramp measures its interval from here so it fires at most once per
    // timeRampMs of healthy-but-slow work.
    let lastActionAt = 0;
    // Whether the most recently recorded item was a transient failure. Gates
    // the time-based ramp so a server failing every request isn't ramped into.
    let lastWasTransient = false;
    const ctrl: BackoffController = {
        cap: cfg.ceiling,
        forceBackoff(nowMs) {
            // Identical to the overload branch in record() below — halve toward
            // the floor, clear the recovery streak, and drop the latency window
            // — but driven by an external signal (the 404-storm detector)
            // rather than a measured rolling average. Stamp both timestamps so
            // the time-ramp measures its interval from this action and the
            // halving rate-limit applies as usual.
            lastBackoffAt = nowMs;
            lastActionAt = nowMs;
            ctrl.cap = Math.max(cfg.floor, Math.floor(ctrl.cap / 2));
            consecutiveFast = 0;
            latency.length = 0;
        },
        recentAvgMs() {
            if (latency.length === 0) return 0;
            return Math.round(latency.reduce((a, b) => a + b, 0) / latency.length);
        },
        record(latencyMs, isTransient, nowMs) {
            // Transient failures (instant 5xx, 20s timeouts) are NOT a latency
            // signal — a 503 in 50ms isn't "fast and healthy" and a timeout
            // isn't a congestion measurement. Keep them out of the rolling
            // window entirely; overload from real errors is governed elsewhere
            // (the HTTP-status cooldown / floored retries).
            if (!isTransient) {
                const sample =
                    cfg.clampMs !== undefined ? Math.min(latencyMs, cfg.clampMs) : latencyMs;
                latency.push(sample);
                if (latency.length > cfg.window) latency.shift();
            }
            lastWasTransient = isTransient;

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
                lastActionAt = nowMs;
                ctrl.cap = Math.max(cfg.floor, Math.floor(ctrl.cap / 2));
                consecutiveFast = 0;
                latency.length = 0;
                return 'backoff';
            }

            // Recovery: double after a streak of fast items.
            if (ctrl.cap < cfg.ceiling && consecutiveFast >= cfg.recoverStreak) {
                consecutiveFast = 0;
                lastActionAt = nowMs;
                ctrl.cap = Math.min(cfg.ceiling, ctrl.cap * 2);
                return 'rampup';
            }

            // Time-based unconditional ramp-up: escape a floored cap when items
            // are healthy-but-slow (never under fastItemMs) so the multiplicative
            // path above can never fire. Gated on a genuine recent completion so
            // a server failing every request isn't ramped into harder.
            if (
                cfg.timeRampMs !== undefined &&
                ctrl.cap < cfg.ceiling &&
                !lastWasTransient &&
                nowMs - lastActionAt >= cfg.timeRampMs
            ) {
                lastActionAt = nowMs;
                ctrl.cap = Math.min(
                    cfg.ceiling,
                    Math.max(ctrl.cap + 1, Math.floor(ctrl.cap * 1.5)),
                );
                return 'rampup';
            }
            return 'none';
        },
    };
    return ctrl;
};
