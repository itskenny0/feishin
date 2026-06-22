// Regression tests for the thumbnail-sweep adaptive backoff controller.
//
// Symptom (slow phone-hosted Jellyfin): the sweep starts fast then crawls
// after ~2000 items. Root cause: the old design HALVED effective concurrency
// on a rolling slow window but recovered only +1 per fast item, so once a slow
// patch floored the cap near 1 it could take hundreds of fast items — or, after
// a sustained slow stretch, effectively never — to climb back to the ceiling.
//
// The controller is now SYMMETRIC: multiplicative down (halve) on overload,
// multiplicative up (double after K consecutive fast items) on recovery. These
// tests pin that ramp so a future tweak can't reintroduce the crawl.

import { describe, expect, it } from 'vitest';

import { createBackoffController } from '/@/renderer/cache/sync/backoff';

const CFG = {
    ceiling: 24,
    fastItemMs: 2_500,
    floor: 1,
    pauseMs: 2_000,
    recoverStreak: 3,
    thresholdMs: 5_000,
    window: 8,
};

// Feed `n` items of a fixed latency at monotonically increasing timestamps far
// enough apart that the backoff rate-limit (pauseMs * 2) never blocks a halving.
const feed = (
    ctrl: ReturnType<typeof createBackoffController>,
    latencyMs: number,
    n: number,
    isTransient = false,
    startTs = 1_000_000,
    stepMs = 10_000,
): string[] => {
    const actions: string[] = [];
    let ts = startTs;
    for (let i = 0; i < n; i += 1) {
        actions.push(ctrl.record(latencyMs, isTransient, ts));
        ts += stepMs;
    }
    return actions;
};

describe('createBackoffController', () => {
    it('starts at the configured ceiling', () => {
        const ctrl = createBackoffController(CFG);
        expect(ctrl.cap).toBe(24);
    });

    it('does not back off until the latency window has filled', () => {
        const ctrl = createBackoffController(CFG);
        // window-1 slow items: not enough samples yet.
        const actions = feed(ctrl, 20_000, CFG.window - 1);
        expect(actions.every((a) => a === 'none')).toBe(true);
        expect(ctrl.cap).toBe(24);
    });

    it('halves the cap on a full window of slow items', () => {
        const ctrl = createBackoffController(CFG);
        const actions = feed(ctrl, 20_000, CFG.window);
        expect(actions[actions.length - 1]).toBe('backoff');
        expect(ctrl.cap).toBe(12);
    });

    it('floors the cap at the configured floor, never below', () => {
        const ctrl = createBackoffController(CFG);
        // Many slow windows. Each window clears latency, so feed window items
        // per intended halving. 24→12→6→3→1 needs ~4 halvings.
        for (let h = 0; h < 6; h += 1) {
            feed(ctrl, 20_000, CFG.window, false, 1_000_000 + h * 200_000);
        }
        expect(ctrl.cap).toBe(CFG.floor);
        expect(ctrl.cap).toBeGreaterThanOrEqual(1);
    });

    it('recovers MULTIPLICATIVELY: doubles after a streak of fast items', () => {
        const ctrl = createBackoffController(CFG);
        // Drive the cap down to 1.
        for (let h = 0; h < 6; h += 1) {
            feed(ctrl, 20_000, CFG.window, false, 1_000_000 + h * 200_000);
        }
        expect(ctrl.cap).toBe(1);

        // Now a streak of fast items. Each `recoverStreak` fast items doubles
        // the cap: 1→2→4→8→16→24(ceiling). That's ~5 doublings ⇒ ~15 fast
        // items — a handful, NOT hundreds (the old +1-per-fast bug).
        const fast = feed(ctrl, 500, CFG.recoverStreak * 6, false, 3_000_000);
        expect(fast.filter((a) => a === 'rampup').length).toBeGreaterThanOrEqual(4);
        expect(ctrl.cap).toBe(24);
    });

    it('reaches the ceiling from the floor within ~15 fast items', () => {
        const ctrl = createBackoffController(CFG);
        for (let h = 0; h < 6; h += 1) {
            feed(ctrl, 20_000, CFG.window, false, 1_000_000 + h * 200_000);
        }
        expect(ctrl.cap).toBe(1);
        // 1→24 is 5 doublings (1,2,4,8,16,24) ⇒ recoverStreak*5 = 15 items.
        feed(ctrl, 500, CFG.recoverStreak * 5, false, 3_000_000);
        expect(ctrl.cap).toBe(24);
    });

    it('does NOT count fast TRANSIENT failures toward recovery', () => {
        const ctrl = createBackoffController(CFG);
        for (let h = 0; h < 6; h += 1) {
            feed(ctrl, 20_000, CFG.window, false, 1_000_000 + h * 200_000);
        }
        expect(ctrl.cap).toBe(1);

        // A server instantly 503-ing every request is "fast" by latency but is
        // NOT healthy — ramping up would just hammer it harder. Transient fast
        // items must not advance the recovery streak.
        const actions = feed(ctrl, 50, CFG.recoverStreak * 4, true, 3_000_000);
        expect(actions.every((a) => a === 'none')).toBe(true);
        expect(ctrl.cap).toBe(1);
    });

    it('resets the fast streak when a slow item interrupts it', () => {
        const ctrl = createBackoffController(CFG);
        for (let h = 0; h < 6; h += 1) {
            feed(ctrl, 20_000, CFG.window, false, 1_000_000 + h * 200_000);
        }
        expect(ctrl.cap).toBe(1);

        // Two fast then a slow (under threshold avg so no backoff) then resume:
        // the streak should have reset, so the cap stays at 1 until a fresh
        // full streak accumulates.
        let ts = 3_000_000;
        ctrl.record(500, false, ts); // fast 1
        ts += 10_000;
        ctrl.record(500, false, ts); // fast 2 (streak interrupted next)
        ts += 10_000;
        ctrl.record(4_000, false, ts); // slow-ish but under-window avg; resets streak
        ts += 10_000;
        // Only one more fast item — not a full fresh streak.
        const a = ctrl.record(500, false, ts);
        expect(a).toBe('none');
        expect(ctrl.cap).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Stage 1 (sync-pipeline-redesign): the freeze-proof, self-recovering controller.
//
// Root cause of the on-device crawl: steady-state items measured 7.5-17s (above
// fastItemMs, so the multiplicative recovery NEVER fired) while a backgrounded
// WebView produced 22-minute `Date.now()` "latency" samples that floored the cap
// and pinned it at the floor for the entire run. Two new OPT-IN config fields fix
// it without changing the legacy controller (every test above still uses the
// no-clamp/no-timeRamp config):
//   - clampMs:   bound each non-transient sample so one doze-freeze can't
//                dominate the window average.
//   - timeRampMs: an unconditional time-based ramp-up so the cap escapes the
//                floor even when items are healthy-but-slow (never under
//                fastItemMs). Gated on a genuine (non-transient) recent
//                completion so a server failing every request isn't ramped into.
// Transient samples are kept out of the rolling window entirely (a 503 in 50ms
// is not a "fast" latency measurement, and a timeout is not a congestion signal).
describe('createBackoffController — freeze-proof time ramp (Stage 1)', () => {
    const RAMP_CFG = { ...CFG, clampMs: 30_000, floor: 4, timeRampMs: 8_000 };

    // Drive the cap to the floor with sustained 40s overload. Items are spaced
    // TIGHTER than timeRampMs(8s) so the time ramp cannot undo a back-off
    // mid-drain (a real overloaded server completes items back-to-back, so this
    // is the realistic cadence); a 40-item run halves 24→12→6→4 and floors.
    const drainToFloor = (ctrl: ReturnType<typeof createBackoffController>): void => {
        feed(ctrl, 40_000, 40, false, 1_000_000, 1_000);
    };

    it('escapes the floor via the time ramp when items are healthy-but-slow', () => {
        const ctrl = createBackoffController(RAMP_CFG);
        drainToFloor(ctrl);
        expect(ctrl.cap).toBe(RAMP_CFG.floor); // 4

        // Steady 3s items: above fastItemMs(2500) so NO multiplicative recovery,
        // below thresholdMs(5000) so NO backoff. Without the time ramp the cap
        // would stay pinned at the floor forever (the real bug). Spaced past
        // timeRampMs so each one is eligible to step the cap up.
        const actions = feed(ctrl, 3_000, 20, false, 5_000_000, 9_000);
        expect(actions.filter((a) => a === 'rampup').length).toBeGreaterThanOrEqual(3);
        expect(ctrl.cap).toBe(RAMP_CFG.ceiling); // climbed back to 24
    });

    it('does NOT time-ramp while the server is failing every request (transient)', () => {
        const ctrl = createBackoffController(RAMP_CFG);
        drainToFloor(ctrl);
        expect(ctrl.cap).toBe(RAMP_CFG.floor);

        // Fast transient 503s spaced past timeRampMs must NOT ramp — ramping
        // would just hammer an unhealthy server harder.
        const actions = feed(ctrl, 50, 20, true, 5_000_000, 9_000);
        expect(actions.every((a) => a === 'none')).toBe(true);
        expect(ctrl.cap).toBe(RAMP_CFG.floor);
    });

    it('clamps a doze-inflated sample so one freeze cannot floor the cap', () => {
        const ctrl = createBackoffController(RAMP_CFG);
        // Seven fast (300ms) then one 30-MINUTE freeze sample. Unclamped the
        // window avg would be ~225_000ms (instant floor); clamped to 30_000 the
        // avg is (7*300 + 30000)/8 ≈ 4012ms < thresholdMs(5000) → NO backoff.
        let ts = 1_000_000;
        let last = 'none';
        for (let i = 0; i < RAMP_CFG.window - 1; i += 1) {
            ctrl.record(300, false, ts);
            ts += 1_000;
        }
        last = ctrl.record(1_800_000, false, ts); // 30-min freeze
        expect(last).not.toBe('backoff');
        expect(ctrl.cap).toBe(RAMP_CFG.ceiling);
    });

    it('keeps transient samples out of the latency window', () => {
        const ctrl = createBackoffController(RAMP_CFG);
        // A full window of SLOW TRANSIENT items (20s timeouts) must not back off:
        // failures are not a congestion measurement.
        const actions = feed(ctrl, 20_000, RAMP_CFG.window, true, 1_000_000);
        expect(actions.every((a) => a === 'none')).toBe(true);
        expect(ctrl.cap).toBe(RAMP_CFG.ceiling);
    });

    it('still backs off on genuine sustained overload (clamped, non-transient)', () => {
        const ctrl = createBackoffController(RAMP_CFG);
        // A full window of real 20s items (clamp 30s leaves them at 20s) averages
        // 20000 > thresholdMs(5000) → halve. Proves the brake still works.
        const actions = feed(ctrl, 20_000, RAMP_CFG.window, false, 1_000_000);
        expect(actions[actions.length - 1]).toBe('backoff');
        expect(ctrl.cap).toBe(12);
    });
});
