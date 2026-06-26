// Soft-miss / hard-miss model for thumbnail negative-cache markers.
//
// A 404 from a flaky / overloaded server is NOT proof the artwork is gone. A
// load-shedding Jellyfin returns SILENT 404s for covers that actually exist
// (observed on-device: ~46k false "no artwork" markers in one hour, with ZERO
// 5xx in the server logs). The old code wrote a hard 7-day marker on every
// one of those, so the UI showed a placeholder for a week.
//
// The fix is a tentative-then-authoritative model keyed on a per-row
// `MissCount`:
//   - The FIRST 404 writes a SOFT marker (MissCount 1). It ages out fast
//     (SOFT_MISS_TTL_MS) so the very next sweep re-checks the item — a
//     transient load-shed 404 is corrected almost immediately.
//   - A SECOND 404 (MissCount >= 2) PROMOTES the marker to authoritative and
//     it is held for the full HARD_MISS_TTL_MS. Genuinely artless
//     items 404 twice and settle into the long TTL within two sweeps.
//
// Both the lazy resolver (images.ts) and the bulk sweep (thumbnails.ts) share
// these constants + helper so a miss's freshness is judged identically
// wherever it's read or written.

// First-404 tentative window: short, so a false load-shed 404 is re-checked
// almost immediately.
export const SOFT_MISS_TTL_MS = 30 * 60 * 1000; // 30 min

// Confirmed-miss window, applied once a second 404 promotes the marker. Most
// Jellyfin libraries don't grow artwork out of thin air, so a week between
// retries keeps the table small without forcing a manual clear after a re-tag.
export const HARD_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Back-compat alias for the old flat constant name (previously 7 days
// everywhere). Kept so any future importer of the old name resolves to the
// hard window; the per-row helper below is what code should actually use.
export const MISS_TTL_MS = HARD_MISS_TTL_MS;

/**
 * Per-row miss freshness window. A row's first 404 (MissCount 1 / undefined)
 * is only honoured for `SOFT_MISS_TTL_MS` so the next sweep re-checks it; a
 * promoted miss (MissCount >= 2) is honoured for the full `HARD_MISS_TTL_MS`.
 *
 * Treating an undefined MissCount as 1 (soft) is deliberate: legacy markers
 * written before this field existed get the short window and are re-validated
 * once, which is exactly what we want for the 46k false markers already on
 * disk that predate the fix.
 */
export const missTtlMs = (missCount?: number): number =>
    (missCount ?? 1) >= 2 ? HARD_MISS_TTL_MS : SOFT_MISS_TTL_MS;
