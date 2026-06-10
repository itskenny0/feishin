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
