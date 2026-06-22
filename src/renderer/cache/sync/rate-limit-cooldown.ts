// Pool-wide rate-limit cooldown for the thumbnail sweep.
//
// A 429/503 from the server arms a cooldown that parks every sweep worker until
// it expires (Retry-After honored when present; otherwise an exponential
// default on repeated 5xx, 2s→4s→8s→16s→30s). Unlike the latency backoff this
// keys on REAL server responses, so it can't be poisoned by background/doze —
// a frozen timer only ever finds the deadline already past and proceeds.
//
// Module-scoped singleton: both fetch paths feed it (the download resolver in
// images.ts and the downscale fetch in thumbnails.ts), and the sweep worker
// loop reads getCooldownUntil(). resetCooldown() runs per sweep so one server's
// 429 can never gate the next server's sweep.

let cooldownUntil = 0;
let consecutive5xx = 0;

const MIN_MS = 2_000;
const MAX_MS = 30_000;

/**
 * Parse a `Retry-After` header into milliseconds-from-now. Accepts both forms:
 * delta-seconds (`"5"`) and an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns undefined when absent/unparseable so the caller falls back to the
 * exponential default. A past date clamps to 0.
 */
export const parseRetryAfterMs = (header: null | string, now = Date.now()): number | undefined => {
    if (!header) return undefined;
    const trimmed = header.trim();
    if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
    const parsed = Date.parse(trimmed);
    if (Number.isNaN(parsed)) return undefined;
    return Math.max(0, parsed - now);
};

/**
 * Record a server response. Only 429/503 arm a cooldown; everything else is a
 * no-op here. The new cooldown is the MAX of the current and the computed one
 * (a later short cooldown can't shorten an in-flight longer one).
 */
export const noteRateLimit = (status: number, retryAfterHeader: null | string): void => {
    if (status !== 429 && status !== 503) return;
    const expDefault = Math.min(MIN_MS << Math.min(consecutive5xx, 4), MAX_MS);
    const parsed = parseRetryAfterMs(retryAfterHeader);
    const cooldownMs = Math.min(MAX_MS, Math.max(MIN_MS, parsed ?? expDefault));
    const until = Date.now() + cooldownMs;
    if (Number.isFinite(until)) cooldownUntil = Math.max(cooldownUntil, until);
    consecutive5xx += 1;
    console.warn('[image-variants] rate-limit cooldown', {
        cooldownMs,
        retryAfter: retryAfterHeader,
        status,
    });
};

/**
 * Record an authoritative HEALTHY response (2xx blob or 404). Resets the 5xx
 * streak so the exponential default doesn't keep escalating across a healthy
 * interleave. Does NOT clear an in-flight cooldown — let it expire naturally.
 */
export const noteOk = (): void => {
    consecutive5xx = 0;
};

/** The timestamp (ms epoch) until which the pool should stay parked. */
export const getCooldownUntil = (): number => cooldownUntil;

/** Reset for a new sweep so a previous server's 429 can't gate this one. */
export const resetCooldown = (): void => {
    cooldownUntil = 0;
    consecutive5xx = 0;
    console.info('[image-variants] rate-limit cooldown reset');
};
