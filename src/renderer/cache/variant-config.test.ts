// Pure-function tests for the artwork-variant config helpers. These pin:
//  - `enabledVariants(cfg)` lists only enabled buckets, in target-px order,
//    each with its resolved px.
//  - `nearestLargerVariant(requested, cachedSet)` picks the smallest cached
//    variant whose px is >= the requested variant's px (px 0 = original =
//    +Infinity); falls back to the largest available when nothing is larger.
//  - `variantConfigHash(cfg)` is stable for equal config and changes when any
//    px / format / quality / mode changes.

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';

import { describe, expect, it } from 'vitest';

import {
    applyThumbnailPreset,
    detectThumbnailPreset,
    enabledVariants,
    nearestLargerVariant,
    variantConfigHash,
} from '/@/renderer/cache/variant-config';
import { DEFAULT_IMAGE_VARIANTS } from '/@/renderer/store/settings.store';

const clone = (): LocalCacheImageVariants =>
    JSON.parse(JSON.stringify(DEFAULT_IMAGE_VARIANTS)) as LocalCacheImageVariants;

// The shipping default has fullScreen (original) AND header (redundant 300px)
// disabled. These helper tests exercise the full bucket set — "original sorts
// last" and the 300px header/itemCard name-tiebreak — so they enable both
// explicitly, independent of the app default.
const withFullScreen = (): LocalCacheImageVariants => {
    const cfg = clone();
    cfg.variants.fullScreen.enabled = true;
    cfg.variants.header.enabled = true;
    return cfg;
};

describe('enabledVariants', () => {
    it('returns only the enabled buckets with their resolved px', () => {
        const result = enabledVariants(withFullScreen());
        // All four bounded thumbnail buckets — table(80), itemCard(300),
        // header(300), sidebar(400) — are enabled by default, plus fullScreen
        // (0=orig) enabled by this fixture.
        const names = result.map((v) => v.variant);
        expect(names).toContain('table');
        expect(names).toContain('itemCard');
        expect(names).toContain('header');
        expect(names).toContain('sidebar');
        expect(names).toContain('fullScreen');
        expect(result).toHaveLength(5);

        const byName = Object.fromEntries(result.map((v) => [v.variant, v.px]));
        expect(byName.table).toBe(80);
        expect(byName.itemCard).toBe(300);
        expect(byName.header).toBe(300);
        expect(byName.sidebar).toBe(400);
        expect(byName.fullScreen).toBe(0);
    });

    it('orders results by effective px ascending (original/0 last), name tiebreak', () => {
        const result = enabledVariants(withFullScreen());
        // table(80) < header(300)=itemCard(300) < fullScreen(0 -> Infinity).
        expect(result[0].variant).toBe('table');
        expect(result.at(-1)?.variant).toBe('fullScreen');
        // 300-px tie broken by name (header before itemCard).
        const headerIdx = result.findIndex((v) => v.variant === 'header');
        const itemCardIdx = result.findIndex((v) => v.variant === 'itemCard');
        expect(headerIdx).toBeLessThan(itemCardIdx);
    });

    it('returns [] when nothing is enabled', () => {
        const cfg = clone();
        for (const key of Object.keys(cfg.variants) as (keyof typeof cfg.variants)[]) {
            cfg.variants[key].enabled = false;
        }
        expect(enabledVariants(cfg)).toEqual([]);
    });
});

describe('nearestLargerVariant', () => {
    it('returns the smallest cached variant whose px >= requested px', () => {
        // Requesting table (80) with only itemCard(300) & header(300) cached:
        // both are >= 80; tie broken by smaller px then name -> header? both
        // 300 so name tiebreak: header < itemCard alphabetically.
        const cached = { header: 300, itemCard: 300 };
        const result = nearestLargerVariant('table', cached, DEFAULT_IMAGE_VARIANTS);
        // Both candidates are 300 px (>= 80); the documented tiebreak is name
        // ascending, so `header` wins deterministically.
        expect(result).toBe('header');
    });

    it('prefers a smaller-px candidate over a larger one when both are >= requested', () => {
        const cached = { fullScreen: 0, itemCard: 300, table: 80 };
        // Request sidebar (400 px). itemCard(300) is too small; fullScreen(orig)
        // is +Infinity -> only candidate >= 400.
        const result = nearestLargerVariant('sidebar', cached, DEFAULT_IMAGE_VARIANTS);
        expect(result).toBe('fullScreen');
    });

    it('falls back to the largest available when nothing is larger', () => {
        // Request fullScreen (original/+Infinity) with only table(80) cached:
        // nothing is larger -> largest available is table.
        const result = nearestLargerVariant('fullScreen', { table: 80 }, DEFAULT_IMAGE_VARIANTS);
        expect(result).toBe('table');
    });

    it('returns the exact variant if it is itself cached', () => {
        const cached = { itemCard: 300, table: 80 };
        expect(nearestLargerVariant('table', cached, DEFAULT_IMAGE_VARIANTS)).toBe('table');
    });

    it('returns undefined when nothing is cached', () => {
        expect(nearestLargerVariant('table', {}, DEFAULT_IMAGE_VARIANTS)).toBeUndefined();
    });
});

describe('variantConfigHash', () => {
    it('is stable for equal config', () => {
        expect(variantConfigHash(DEFAULT_IMAGE_VARIANTS)).toBe(variantConfigHash(clone()));
    });

    it('changes when a variant px changes', () => {
        const cfg = clone();
        cfg.variants.table.px = 96;
        expect(variantConfigHash(cfg)).not.toBe(variantConfigHash(DEFAULT_IMAGE_VARIANTS));
    });

    it('changes when format changes', () => {
        const cfg = clone();
        cfg.format = 'jpeg';
        expect(variantConfigHash(cfg)).not.toBe(variantConfigHash(DEFAULT_IMAGE_VARIANTS));
    });

    it('changes when quality changes', () => {
        const cfg = clone();
        cfg.quality = 70;
        expect(variantConfigHash(cfg)).not.toBe(variantConfigHash(DEFAULT_IMAGE_VARIANTS));
    });

    it('changes when mode changes', () => {
        const cfg = clone();
        // 'download' is the default, so toggle to the non-default 'downscale'
        // to prove the mode participates in the hash.
        cfg.mode = 'downscale';
        expect(variantConfigHash(cfg)).not.toBe(variantConfigHash(DEFAULT_IMAGE_VARIANTS));
    });

    it('changes when a variant is toggled', () => {
        const cfg = clone();
        // fullScreen is the one bucket still disabled by default — enabling it
        // must change the hash.
        cfg.variants.fullScreen.enabled = true;
        expect(variantConfigHash(cfg)).not.toBe(variantConfigHash(DEFAULT_IMAGE_VARIANTS));
    });
});

describe('thumbnail presets', () => {
    const withBuckets = (names: string[]): LocalCacheImageVariants => {
        const cfg = clone();
        for (const k of ['header', 'itemCard', 'sidebar', 'table'] as const) {
            cfg.variants[k].enabled = names.includes(k);
        }
        return cfg;
    };

    it('detects the shipped default (itemCard + sidebar + table) as balanced', () => {
        expect(detectThumbnailPreset(DEFAULT_IMAGE_VARIANTS)).toBe('balanced');
    });

    it('detects speed (itemCard + table only)', () => {
        expect(detectThumbnailPreset(withBuckets(['itemCard', 'table']))).toBe('speed');
    });

    it('detects full (all four bounded buckets)', () => {
        expect(
            detectThumbnailPreset(withBuckets(['header', 'itemCard', 'sidebar', 'table'])),
        ).toBe('full');
    });

    it('detects custom for any non-preset combination', () => {
        expect(detectThumbnailPreset(withBuckets(['table']))).toBe('custom');
        expect(detectThumbnailPreset(withBuckets(['header', 'table']))).toBe('custom');
    });

    it('ignores fullScreen when detecting the preset (it is an independent opt-in)', () => {
        const cfg = withBuckets(['itemCard', 'table']);
        cfg.variants.fullScreen.enabled = true;
        expect(detectThumbnailPreset(cfg)).toBe('speed');
    });

    it('applyThumbnailPreset(speed) enables only itemCard + table, disables the rest', () => {
        const variants = applyThumbnailPreset(
            withBuckets(['header', 'itemCard', 'sidebar', 'table']),
            'speed',
        );
        expect(variants.table.enabled).toBe(true);
        expect(variants.itemCard.enabled).toBe(true);
        expect(variants.sidebar.enabled).toBe(false);
        expect(variants.header.enabled).toBe(false);
    });

    it('applyThumbnailPreset preserves px values and the fullScreen opt-in', () => {
        const cfg = withBuckets(['itemCard', 'table']);
        cfg.variants.fullScreen.enabled = true;
        cfg.variants.sidebar.px = 512;
        const variants = applyThumbnailPreset(cfg, 'full');
        expect(variants.sidebar.px).toBe(512); // px untouched
        expect(variants.fullScreen.enabled).toBe(true); // independent opt-in untouched
        expect(variants.sidebar.enabled).toBe(true);
    });

    it('round-trips: detect(apply(preset)) === preset', () => {
        for (const preset of ['speed', 'balanced', 'full'] as const) {
            const variants = applyThumbnailPreset(clone(), preset);
            expect(detectThumbnailPreset({ ...clone(), variants })).toBe(preset);
        }
    });
});
