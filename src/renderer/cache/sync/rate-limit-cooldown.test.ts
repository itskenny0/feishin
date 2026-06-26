import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    getCooldownUntil,
    isServerStressed,
    note404,
    noteOk,
    noteRateLimit,
    parseRetryAfterMs,
    resetCooldown,
} from './rate-limit-cooldown';

// getCooldownUntil is an absolute epoch ms; remaining() is the ms-from-now.
const remaining = (): number => Math.max(0, getCooldownUntil() - Date.now());

beforeEach(() => {
    resetCooldown();
});

describe('parseRetryAfterMs', () => {
    it('parses delta-seconds', () => {
        expect(parseRetryAfterMs('5')).toBe(5000);
        expect(parseRetryAfterMs('  12 ')).toBe(12000);
    });

    it('parses an HTTP-date relative to now', () => {
        const now = 1_000_000_000_000;
        const future = new Date(now + 10_000).toUTCString();
        expect(parseRetryAfterMs(future, now)).toBe(10_000);
    });

    it('clamps a past HTTP-date to 0', () => {
        const now = 1_000_000_000_000;
        const past = new Date(now - 60_000).toUTCString();
        expect(parseRetryAfterMs(past, now)).toBe(0);
    });

    it('returns undefined for missing / unparseable headers', () => {
        expect(parseRetryAfterMs(null)).toBeUndefined();
        expect(parseRetryAfterMs('')).toBeUndefined();
        expect(parseRetryAfterMs('not-a-date')).toBeUndefined();
    });
});

describe('noteRateLimit', () => {
    it('ignores non-429/503 statuses', () => {
        noteRateLimit(200, null);
        noteRateLimit(404, null);
        noteRateLimit(500, null);
        expect(remaining()).toBe(0);
    });

    it('arms a 2s floor on a 429 with no Retry-After', () => {
        noteRateLimit(429, null);
        expect(remaining()).toBeGreaterThanOrEqual(1900);
        expect(remaining()).toBeLessThanOrEqual(2000);
    });

    it('honors Retry-After (clamped to [2s,30s])', () => {
        noteRateLimit(429, '5');
        expect(remaining()).toBeGreaterThanOrEqual(4900);
        expect(remaining()).toBeLessThanOrEqual(5000);
        resetCooldown();
        noteRateLimit(503, '600'); // 10min → clamped to 30s
        expect(remaining()).toBeLessThanOrEqual(30_000);
        expect(remaining()).toBeGreaterThanOrEqual(29_900);
    });

    it('escalates exponentially on consecutive 5xx (2→4→8→16→30s cap)', () => {
        noteRateLimit(503, null);
        expect(remaining()).toBeLessThanOrEqual(2000);
        noteRateLimit(503, null);
        expect(remaining()).toBeGreaterThanOrEqual(3900);
        expect(remaining()).toBeLessThanOrEqual(4000);
        noteRateLimit(503, null);
        expect(remaining()).toBeLessThanOrEqual(8000);
        noteRateLimit(503, null); // 16s
        noteRateLimit(503, null); // 32s → cap 30s
        expect(remaining()).toBeLessThanOrEqual(30_000);
        expect(remaining()).toBeGreaterThanOrEqual(29_900);
    });

    it('keeps the MAX of overlapping cooldowns (a short one cannot shorten a long one)', () => {
        noteRateLimit(429, '20'); // 20s
        noteRateLimit(429, '2'); // 2s — must NOT shorten
        expect(remaining()).toBeGreaterThanOrEqual(19_900);
    });
});

describe('resetCooldown', () => {
    it('zeroes the cooldown and the streak', () => {
        noteRateLimit(503, null);
        noteRateLimit(503, null);
        resetCooldown();
        expect(remaining()).toBe(0);
        // streak reset → next 5xx starts at the 2s floor again
        noteRateLimit(503, null);
        expect(remaining()).toBeLessThanOrEqual(2000);
    });
});

describe('noteOk', () => {
    it('does not clear an in-flight cooldown', () => {
        noteRateLimit(429, '10');
        noteOk();
        expect(remaining()).toBeGreaterThanOrEqual(9900);
    });
});

// note404 is the THROUGHPUT layer for a server that load-sheds with SILENT
// 404s (never 429/503): a long UNBROKEN run of authoritative 404s arms the
// same exponential cooldown a 503 would. It must NOT trip on legitimately
// artless items, which interleave with 200s (those reset the run via noteOk).
describe('note404 — load-shed 404 throttle', () => {
    it('does NOT arm below the consecutive-404 threshold', () => {
        // 11 < the 12 threshold: a handful of artless items must never throttle.
        for (let i = 0; i < 11; i += 1) {
            expect(note404().armed).toBe(false);
        }
        expect(remaining()).toBe(0);
    });

    it('does NOT arm on a pure-404 storm (genuine artless artists, no 5xx)', () => {
        // The decisive fix: a 14k-artist library 404s in long UNBROKEN runs on a
        // perfectly HEALTHY server. With no 429/5xx corroboration, a pure-404
        // storm must NOT arm — otherwise it parks the pool AND (via
        // isServerStressed → cooldownUntil>now) suppresses the artless markers
        // into an infinite re-fetch loop.
        let last = { armed: false, consecutive404: 0, cooldownMs: 0 };
        for (let i = 0; i < 50; i += 1) last = note404();
        expect(last.armed).toBe(false);
        expect(remaining()).toBe(0);
    });

    it('a pure-404 storm does NOT mark the server stressed', () => {
        for (let i = 0; i < 50; i += 1) note404();
        expect(isServerStressed()).toBe(false);
    });

    it('a genuine 2xx (noteOk) resets the run — interleaved artless 404s never trip it', () => {
        // 11 consecutive 404s, a single success, then 11 more: the success
        // breaks the run, so neither half ever reaches the threshold.
        for (let i = 0; i < 11; i += 1) note404();
        noteOk();
        for (let i = 0; i < 11; i += 1) {
            expect(note404().armed).toBe(false);
        }
        expect(remaining()).toBe(0);
    });

    it('arms only when a 404 storm is corroborated by a real 5xx/cooldown', () => {
        // A genuine load-shed presents as 429/5xx; that corroboration (an active
        // cooldown) lets the concurrent 404 storm escalate the park. Without it
        // (the pure-404 cases above) it never arms.
        noteRateLimit(503, null); // real 5xx → arms the cooldown (corroboration)
        let last = { armed: false, consecutive404: 0, cooldownMs: 0 };
        for (let i = 0; i < 12; i += 1) last = note404();
        expect(last.armed).toBe(true);
    });

    it('Change 3: a 404 with a CLEAR cooldown decays the 5xx stress streak', () => {
        vi.useFakeTimers();
        try {
            resetCooldown();
            // Two 500s build the streak to 2 (isServerStressed true) and the
            // second arms a ~4s cooldown.
            noteRateLimit(500, null); // streak 1, no arm
            noteRateLimit(500, null); // streak 2, arms ~4s
            expect(isServerStressed()).toBe(true);
            // The server now serves ZERO covers (only 404s) but stops 5xx-ing.
            // Once the cooldown fully expires, a single authoritative 404 decays
            // the 5xx streak so stress can clear — otherwise it would latch
            // forever and suppress every 404 marker.
            vi.advanceTimersByTime(31_000);
            note404();
            expect(isServerStressed()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('Change 3: a 404 does NOT decay the streak while the cooldown is still active', () => {
        noteRateLimit(500, null); // streak 1
        noteRateLimit(500, null); // streak 2 + active cooldown
        expect(isServerStressed()).toBe(true);
        note404(); // cooldown still active → no decay
        // Cooldown is still in flight, so stress stays true regardless.
        expect(isServerStressed()).toBe(true);
    });
});
