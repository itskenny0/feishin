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

/**
 * Whether a cached row written under `storedHash` is stale for the LIVE
 * config — compared on the parameters that actually affect THAT row's
 * pixels: mode, format, quality, and the row's own variant px.
 *
 * Deliberately IGNORES enabled bits and other variants' px: a full-config
 * string compare invalidated every cached cover when an unrelated bit
 * flipped (release 4cab184c7 toggled the DEFAULT fullScreen enabled flag and
 * every user's entire thumbnail cache went "stale" — each cover then dropped
 * its Dexie hit and re-fetched over the network on view).
 *
 * Unparseable hashes are stale (conservative: regenerate). A variant missing
 * from the stored hash is stale (the row predates the variant's definition).
 * A variant the LIVE config doesn't define is fresh — there is no live px to
 * disagree with, and serving the row beats refetching it forever.
 */
export const isRowHashStale = (
    storedHash: string,
    variant: string,
    cfg: LocalCacheImageVariants,
): boolean => {
    const parsed = parseConfigHash(storedHash);
    if (!parsed) return true;
    // Mode (downscale vs download) is intentionally NOT compared: both produce
    // an equivalent {format, quality, px} webp for a given variant, so flipping
    // the default mode must not invalidate every existing row. Treating a
    // mode-only change as stale caused a full regenerate-on-browse churn — and
    // an estimateBytes O(N) scan per regenerated cover — the moment the default
    // flipped. Only the params that actually change the row's bytes gate it.
    if (parsed.format !== cfg.format || parsed.quality !== cfg.quality) return true;
    const storedPx = parsed.variantPx[variant];
    if (storedPx === undefined) return true;
    const live = cfg.variants[variant as VariantName];
    if (!live) return false;
    return storedPx !== live.px;
};

// ---------------------------------------------------------------------------
// Thumbnail-detail presets. A user-facing "speed vs quality" shorthand over the
// per-variant enabled flags: fewer pre-cached bounded sizes = faster first sync
// (a disabled bounded bucket serves from a cached larger sibling via the
// resolver's fallback-only path). fullScreen (the px:0 original) is an
// independent opt-in and is never part of a preset.
export type ThumbnailPreset = 'balanced' | 'custom' | 'full' | 'speed';

// The bounded surface buckets the presets toggle (everything except the px:0
// original). Sorted for stable set comparison.
const BOUNDED_BUCKETS: VariantName[] = ['header', 'itemCard', 'sidebar', 'table'];

// Each preset = the bounded buckets it pre-caches. 'speed' keeps only the
// dense-surface sizes (table rows + grid cards); 'balanced' adds the larger
// sidebar size; 'full' caches every bounded size (incl. the redundant header).
const PRESET_BUCKETS: Record<Exclude<ThumbnailPreset, 'custom'>, VariantName[]> = {
    balanced: ['itemCard', 'sidebar', 'table'],
    full: ['header', 'itemCard', 'sidebar', 'table'],
    speed: ['itemCard', 'table'],
};

const sameBucketSet = (a: VariantName[], b: VariantName[]): boolean =>
    a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** Which preset the config's enabled bounded-bucket set matches, or 'custom'. */
export const detectThumbnailPreset = (cfg: LocalCacheImageVariants): ThumbnailPreset => {
    const enabled = BOUNDED_BUCKETS.filter((v) => cfg.variants[v]?.enabled);
    for (const preset of ['speed', 'balanced', 'full'] as const) {
        if (sameBucketSet(enabled, PRESET_BUCKETS[preset])) return preset;
    }
    return 'custom';
};

/**
 * Apply a preset to a config's variants: enable exactly the preset's bounded
 * buckets, disable the rest. fullScreen and every px value are preserved.
 */
export const applyThumbnailPreset = (
    cfg: LocalCacheImageVariants,
    preset: Exclude<ThumbnailPreset, 'custom'>,
): LocalCacheImageVariants['variants'] => {
    const wanted = new Set(PRESET_BUCKETS[preset]);
    const variants = { ...cfg.variants };
    for (const v of BOUNDED_BUCKETS) {
        variants[v] = { ...variants[v], enabled: wanted.has(v) };
    }
    return variants;
};

// A library at/above this many thumbnail-bearing items (albums+artists+
// playlists) is "large" — auto-tune drops to Speed so the first sync isn't a
// marathon of redundant size fetches.
export const AUTO_LARGE_LIBRARY_ITEMS = 5000;

/**
 * Pick a preset automatically from device class + library size. Returns 'speed'
 * for a large library OR a weak device (so the first sync stays bearable),
 * 'balanced' otherwise. NEVER 'full' — its extra `header` bucket is the
 * redundant 300px sibling of itemCard, so auto-tune never opts into it. A
 * `cores` of 0 (unknown) is treated as not-weak; an undefined deviceMemory is
 * treated as not-weak.
 */
export const autoSelectPreset = (
    itemCount: number,
    cores: number,
    deviceMemoryGB: number | undefined,
): Exclude<ThumbnailPreset, 'custom' | 'full'> => {
    const weakCpu = cores > 0 && cores <= 4;
    const weakMem = deviceMemoryGB !== undefined && deviceMemoryGB <= 4;
    const largeLib = itemCount >= AUTO_LARGE_LIBRARY_ITEMS;
    if (weakCpu || weakMem || largeLib) return 'speed';
    return 'balanced';
};

const parseConfigHash = (
    hash: string,
): null | { format: string; mode: string; quality: number; variantPx: Record<string, number> } => {
    const match = /^m=([^|]+)\|f=([^|]+)\|q=([^|]+)\|(.*)$/.exec(hash);
    if (!match) return null;
    const quality = Number(match[3]);
    if (!Number.isFinite(quality)) return null;
    const variantPx: Record<string, number> = {};
    for (const entry of match[4].split(',')) {
        if (!entry) continue;
        const fields = entry.split(':');
        if (fields.length !== 3) return null;
        const px = Number(fields[2]);
        if (!Number.isFinite(px)) return null;
        variantPx[fields[0]] = px;
    }
    return { format: match[2], mode: match[1], quality, variantPx };
};
