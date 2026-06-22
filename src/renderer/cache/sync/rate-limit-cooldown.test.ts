import { beforeEach, describe, expect, it } from 'vitest';

import {
    getCooldownUntil,
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
