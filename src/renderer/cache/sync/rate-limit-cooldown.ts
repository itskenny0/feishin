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
//
// LOAD-SHED 404 STORM (note404): a slow/overloaded Jellyfin doesn't always
// answer 429/503 — some silently LOAD-SHED by returning HTTP 404 for covers
// that demonstrably exist (fetched individually they're 200). The 24-worker
// sweep then hammers a server that can't keep up, every cover 404s, and nothing
// ever fills — yet noteRateLimit (429/5xx only) never arms, so the pool keeps
// pounding at full concurrency. note404 closes that gap WITHOUT tripping on
// legitimately-artless items: artless artists/playlists 404 at a high rate on a
// HEALTHY server, but they're INTERLEAVED with 200s (which noteOk resets the
// run on). A real load-shed is a long UNBROKEN run of 404s with no success, so
// we count CONSECUTIVE 404s and, past a threshold, arm the SAME exponential
// cooldown a 503 would — treating the storm like a 503 for throttling purposes.
// The escalation uses its OWN counter (loadShed404Arms), kept distinct from the
// 5xx streak so it neither feeds nor is wiped by isServerStressed()'s meaning.

let cooldownUntil = 0;
let consecutive5xx = 0;
// Length of the current UNBROKEN run of authoritative 404s (no intervening
// 2xx). Reset by noteOk (a genuine success) and on each arm so the storm
// re-arms afresh if it continues.
let consecutive404 = 0;
// How many times the 404-storm cooldown has armed in the current storm. Drives
// the exponential step (2s→4s→…→30s) INDEPENDENTLY of consecutive5xx so a 404
// storm escalates without touching the 5xx-stress signal (and so Change-3's
// 5xx-streak decay below can't shorten the storm's escalation).
let loadShed404Arms = 0;

const MIN_MS = 2_000;
const MAX_MS = 30_000;
// A run of this many CONSECUTIVE 404s (no intervening success) is read as a
// load-shed storm rather than a cluster of artless items. 24 workers fan out,
// so on a genuine storm this trips within the first ~12 of the first wave;
// on a healthy library the interleaved 200s keep the run far below it.
const LOADSHED_404_THRESHOLD = 12;

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
 * Record a server response that signals server health. 429 and ANY 5xx feed
 * the `consecutive5xx` streak (the signal `isServerStressed()` reads); 4xx
 * (other than 429) and 2xx are no-ops here — they're the server working fine.
 *
 * Cooldown arming:
 *  - 429 / 503 / an explicit Retry-After arm the cooldown IMMEDIATELY (an
 *    unambiguous "back off now").
 *  - Other 5xx (500/502/504) arm ONLY once we've seen a streak (>= 2). A lone
 *    500 is often a single corrupt image or one flaky upstream hop — parking
 *    the whole pool on it would strand every worker.
 *
 * The new cooldown is the MAX of the current and the computed one (a later
 * short cooldown can't shorten an in-flight longer one). Exponential default +
 * MAX clamp are unchanged from the 429/503-only original.
 */
export const noteRateLimit = (status: number, retryAfterHeader: null | string): void => {
    const is429 = status === 429;
    const is5xx = status >= 500 && status <= 599;
    if (!is429 && !is5xx) return;

    const parsed = parseRetryAfterMs(retryAfterHeader);
    // Exponential default uses the streak BEFORE counting this failure, so the
    // first arm is 2s, then 4s→8s→16s→30s — identical to the original ramp.
    const expDefault = Math.min(MIN_MS << Math.min(consecutive5xx, 4), MAX_MS);

    // Count this failure into the server-health streak (isServerStressed reads
    // `consecutive5xx >= 2`).
    consecutive5xx += 1;

    // Arm now for the unambiguous back-off signals; for a non-503 5xx wait for
    // a streak so one corrupt image / flaky hop doesn't park the whole pool.
    const armNow = is429 || status === 503 || parsed !== undefined || consecutive5xx >= 2;
    if (!armNow) {
        console.warn('[image-variants] server 5xx (building streak, pool not yet parked)', {
            consecutive5xx,
            status,
        });
        return;
    }

    const cooldownMs = Math.min(MAX_MS, Math.max(MIN_MS, parsed ?? expDefault));
    const until = Date.now() + cooldownMs;
    if (Number.isFinite(until)) cooldownUntil = Math.max(cooldownUntil, until);
    console.warn('[image-variants] rate-limit cooldown', {
        consecutive5xx,
        cooldownMs,
        retryAfter: retryAfterHeader,
        status,
    });
};

/**
 * Coarse "is the server currently load-shedding?" signal. Read by the 404
 * write paths to SUPPRESS negative markers under stress — a load-shed 404 is
 * not authoritative, so writing a "no artwork" marker for it is a false
 * positive that strands the cover for the marker's TTL.
 *
 * CRITICAL: stress is ONLY an active cooldown or a 429/5xx streak. We
 * deliberately do NOT factor in a high 404 RATE: artless artists / playlists
 * legitimately 404 at a high rate on a perfectly HEALTHY server, so a
 * 404-rate signal would self-trigger here and suppress every genuine 404 —
 * re-fetching artless items forever.
 */
export const isServerStressed = (): boolean => cooldownUntil > Date.now() || consecutive5xx >= 2;

/** What a note404() call did — lets the sweep mirror the throttle into its
 *  concurrency cap and emit a single warn with the cap snapshot. */
export interface LoadShed404 {
    /** True when THIS 404 just armed the pool-wide load-shed cooldown. */
    armed: boolean;
    /** The consecutive-404 run length at the moment of arming (0 otherwise). */
    consecutive404: number;
    /** The cooldown (ms) this 404 armed (0 when it did not arm). */
    cooldownMs: number;
}

/**
 * Record an authoritative HTTP 404 (the sweep's 'missing' outcome — a soft/hard
 * negative marker was written, i.e. NOT a suppressed-under-stress 404). Feeds
 * the load-shed detector and, when a long unbroken run of 404s crosses
 * LOADSHED_404_THRESHOLD, ARMS the same exponential cooldown a 503 would: the
 * storm is treated like a 503 so the worker pool parks and the slow server gets
 * room to recover. Returns what it did so the sweep can ALSO halve its
 * concurrency cap (a bare cooldown resumes at full concurrency and re-overloads)
 * and log the transition.
 *
 * Distinct from isServerStressed(): the escalation step is its own counter
 * (loadShed404Arms), NOT consecutive5xx — a 404 storm throttles throughput but
 * does not, by itself, claim the server is 5xx-stressed. (While the cooldown is
 * armed isServerStressed() is true anyway via `cooldownUntil > now`, which
 * usefully suppresses further 404 markers for the duration of the park.)
 *
 * Change 3: when the cooldown has FULLY expired, an authoritative non-5xx
 * response (this 404) is evidence the server has stopped 5xx-ing, so we decay
 * the 5xx streak. Without this a server that emitted >= 2 5xx then serves ZERO
 * covers (only 404s) would keep isServerStressed() latched true forever and
 * suppress every 404 marker permanently. Gated on a clear cooldown so we never
 * decay mid-storm. This only affects the stress FLAG — never whether a 404 is
 * trusted (the caller already decided to write a marker before calling here).
 */
export const note404 = (): LoadShed404 => {
    consecutive404 += 1;

    // A 404 storm is treated as load-shedding ONLY when corroborated by a recent
    // 429/5xx or an already-active cooldown — captured BEFORE Change 3 decays the
    // streak. Genuine artless artists/playlists 404 in long UNBROKEN runs on a
    // perfectly HEALTHY server (a 14k-artist library is mostly artless); arming
    // on a pure-404 run mis-fires and — via isServerStressed() → cooldownUntil>now
    // — would SUPPRESS those artless markers, stranding them in an infinite
    // re-fetch loop (the exact failure the design review flagged). A real
    // load-shed presents as 429/5xx (handled by noteRateLimit), so require that
    // corroboration here. Verified on-device: a flaky-looking server actually
    // served 16 parallel covers (200) while the sweep saw ~44k pure-404s — all
    // genuine artless artists, no 5xx.
    const corroborated = consecutive5xx >= 1 || cooldownUntil > Date.now();

    // Change 3: stress-streak decay once the cooldown is clear (see above).
    if (cooldownUntil <= Date.now()) consecutive5xx = 0;

    if (consecutive404 < LOADSHED_404_THRESHOLD || !corroborated) {
        return { armed: false, consecutive404: 0, cooldownMs: 0 };
    }

    const run = consecutive404;
    // Exponential default keyed on the storm's OWN arm count (not the 5xx
    // streak): 2s→4s→8s→16s→30s, escalating if the storm keeps re-arming.
    const expDefault = Math.min(MIN_MS << Math.min(loadShed404Arms, 4), MAX_MS);
    loadShed404Arms += 1;
    const cooldownMs = Math.min(MAX_MS, Math.max(MIN_MS, expDefault));
    const until = Date.now() + cooldownMs;
    if (Number.isFinite(until)) cooldownUntil = Math.max(cooldownUntil, until);
    // Re-arm afresh (with a longer step) if the storm continues after the park.
    consecutive404 = 0;
    return { armed: true, consecutive404: run, cooldownMs };
};

/**
 * Record an authoritative HEALTHY response (2xx blob or 404... no — 2xx ONLY).
 * A genuine 2xx means the server is serving covers, so reset BOTH the 5xx
 * streak (so the exponential default doesn't keep escalating across a healthy
 * interleave) AND the 404-storm detector (so an INTERLEAVED artless-item 404
 * never accumulates toward the storm threshold — only an UNbroken run trips it).
 * Does NOT clear an in-flight cooldown — let it expire naturally.
 */
export const noteOk = (): void => {
    consecutive5xx = 0;
    consecutive404 = 0;
    loadShed404Arms = 0;
};

/** The timestamp (ms epoch) until which the pool should stay parked. */
export const getCooldownUntil = (): number => cooldownUntil;

/** Reset for a new sweep so a previous server's 429 can't gate this one. */
export const resetCooldown = (): void => {
    cooldownUntil = 0;
    consecutive5xx = 0;
    consecutive404 = 0;
    loadShed404Arms = 0;
    console.info('[image-variants] rate-limit cooldown reset');
};
