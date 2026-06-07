// Pure helpers for the multi-resolution artwork-variant cache. No Dexie /
// IndexedDB imports — these are deterministic functions over the
// `localCache.imageVariants` config so they can be unit-tested in isolation and
// reused by the sweep, the resolver, and the settings UI.
//
//  - `enabledVariants(cfg)` — the buckets the sweep should pre-cache, ordered by
//    effective px (ascending; `0` = original sorts last), name as tiebreak.
//  - `nearestLargerVariant(requested, cached, cfg)` — runtime fallback: the
//    smallest cached variant whose px is >= the requested variant's px, falling
//    back to the largest available when nothing is larger. Lets a list cell
//    show a slightly-too-big cover instead of blocking on a re-fetch.
//  - `variantConfigHash(cfg)` — a stable string fingerprint of the config used
//    to detect stale cached rows (a px / format / quality / mode change forces
//    regeneration).

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';

export interface EnabledVariant {
    px: number;
    variant: VariantName;
}

export type VariantName = keyof LocalCacheImageVariants['variants'];

/**
 * `px === 0` means "original / no resize" — treat it as the largest possible
 * size for ordering and nearest-larger comparisons.
 */
const effectivePx = (px: number): number => (px === 0 ? Number.POSITIVE_INFINITY : px);

/** Stable [px asc (0 = +Infinity), then name asc] comparator. */
const byEffectivePxThenName = (
    a: { name: string; px: number },
    b: { name: string; px: number },
): number => {
    const ap = effectivePx(a.px);
    const bp = effectivePx(b.px);
    if (ap !== bp) return ap - bp;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
};

/**
 * The enabled surface buckets the sweep should pre-cache, ordered by effective
 * px ascending (original/0 last), name tiebreak. Empty array = sweep skipped.
 */
export const enabledVariants = (cfg: LocalCacheImageVariants): EnabledVariant[] => {
    const entries = Object.entries(cfg.variants) as [
        VariantName,
        { enabled: boolean; px: number },
    ][];
    return entries
        .filter(([, v]) => v.enabled)
        .map(([variant, v]) => ({ px: v.px, variant }))
        .sort((a, b) =>
            byEffectivePxThenName({ name: a.variant, px: a.px }, { name: b.variant, px: b.px }),
        );
};

/**
 * Runtime fallback: given the variant a surface actually wants and the set of
 * variants currently cached for that item (`{ variantName: px }`), pick the best
 * substitute to show immediately.
 *
 * Rules:
 *  1. Smallest cached variant whose effective px is >= the requested variant's
 *     effective px (so the cover is never too small). Ties (equal px) broken by
 *     name ascending for determinism.
 *  2. If nothing cached is large enough, return the largest available variant
 *     (better an under-sized cover than none).
 *  3. `undefined` when nothing is cached.
 *
 * The requested variant's px comes from the live config; the cached pxs come
 * from the stored rows.
 */
export const nearestLargerVariant = (
    requested: VariantName,
    cached: Partial<Record<string, number>>,
    cfg: LocalCacheImageVariants,
): string | undefined => {
    const candidates = Object.entries(cached)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
        .map(([name, px]) => ({ name, px }));

    if (candidates.length === 0) return undefined;

    const requestedPx = effectivePx(cfg.variants[requested]?.px ?? 0);

    const largerOrEqual = candidates
        .filter((c) => effectivePx(c.px) >= requestedPx)
        .sort(byEffectivePxThenName);

    if (largerOrEqual.length > 0) return largerOrEqual[0].name;

    // Nothing big enough — fall back to the largest available (name tiebreak).
    const largest = [...candidates].sort(byEffectivePxThenName).at(-1);
    return largest?.name;
};

/**
 * Stable fingerprint of the variant config. Equal config -> equal hash; any
 * px / format / quality / mode / enable change -> a different hash. Stored on
 * each cached row so the resolver can detect and regenerate stale variants.
 */
export const variantConfigHash = (cfg: LocalCacheImageVariants): string => {
    const variants = (Object.keys(cfg.variants) as VariantName[])
        .sort()
        .map((name) => {
            const v = cfg.variants[name];
            return `${name}:${v.enabled ? 1 : 0}:${v.px}`;
        })
        .join(',');
    return `m=${cfg.mode}|f=${cfg.format}|q=${cfg.quality}|${variants}`;
};
