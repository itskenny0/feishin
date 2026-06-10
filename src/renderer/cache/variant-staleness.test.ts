// Per-row staleness for cached thumbnail variants.
//
// REGRESSION (device, 2026-06-10): release 4cab184c7 flipped the DEFAULT
// fullScreen variant from enabled→disabled. `variantConfigHash` fingerprints
// the WHOLE config — including every variant's enabled bit — so that flip
// made every previously-cached row "stale". The display path then dropped
// perfectly good Dexie hits and refetched each cover over the network
// (catastrophic against a slow server: covers visibly re-loaded on every
// page visit).
//
// A row's pixels only depend on: mode, format, quality, and THAT variant's
// px. Enabled bits and other variants' px must not invalidate it.

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';

import { describe, expect, it } from 'vitest';

import { isRowHashStale, variantConfigHash } from '/@/renderer/cache/variant-config';

const cfg = (over?: {
    format?: 'jpeg' | 'webp';
    mode?: 'download' | 'downscale';
    quality?: number;
    variants?: Partial<Record<string, { enabled: boolean; px: number }>>;
}): LocalCacheImageVariants =>
    ({
        format: over?.format ?? 'webp',
        mode: over?.mode ?? 'downscale',
        quality: over?.quality ?? 82,
        variants: {
            fullScreen: { enabled: false, px: 0 },
            header: { enabled: true, px: 300 },
            itemCard: { enabled: true, px: 300 },
            sidebar: { enabled: false, px: 400 },
            table: { enabled: true, px: 80 },
            ...over?.variants,
        },
    }) as LocalCacheImageVariants;

describe('isRowHashStale', () => {
    it('is fresh when the stored hash matches the live config exactly', () => {
        const live = cfg();
        expect(isRowHashStale(variantConfigHash(live), 'table', live)).toBe(false);
    });

    it('is fresh when only ANOTHER variant enabled bit changed (the 4cab184c7 regression)', () => {
        const writtenUnder = cfg({ variants: { fullScreen: { enabled: true, px: 0 } } });
        const live = cfg(); // fullScreen now disabled
        expect(isRowHashStale(variantConfigHash(writtenUnder), 'table', live)).toBe(false);
        expect(isRowHashStale(variantConfigHash(writtenUnder), 'itemCard', live)).toBe(false);
    });

    it('is fresh when the SAME variant enabled bit changed (enabled does not change pixels)', () => {
        const writtenUnder = cfg({ variants: { sidebar: { enabled: true, px: 400 } } });
        const live = cfg(); // sidebar now disabled
        expect(isRowHashStale(variantConfigHash(writtenUnder), 'sidebar', live)).toBe(false);
    });

    it('is fresh when only ANOTHER variant px changed', () => {
        const writtenUnder = cfg({ variants: { itemCard: { enabled: true, px: 200 } } });
        const live = cfg(); // itemCard px now 300
        expect(isRowHashStale(variantConfigHash(writtenUnder), 'table', live)).toBe(false);
    });

    it('is stale when THIS variant px changed', () => {
        const writtenUnder = cfg({ variants: { table: { enabled: true, px: 60 } } });
        const live = cfg(); // table px now 80
        expect(isRowHashStale(variantConfigHash(writtenUnder), 'table', live)).toBe(true);
    });

    it('is stale when quality changed', () => {
        expect(isRowHashStale(variantConfigHash(cfg({ quality: 70 })), 'table', cfg())).toBe(true);
    });

    it('is stale when format changed', () => {
        expect(isRowHashStale(variantConfigHash(cfg({ format: 'jpeg' })), 'table', cfg())).toBe(
            true,
        );
    });

    it('is stale when mode changed', () => {
        expect(isRowHashStale(variantConfigHash(cfg({ mode: 'download' })), 'table', cfg())).toBe(
            true,
        );
    });

    it('is stale when the stored hash is unparseable garbage', () => {
        expect(isRowHashStale('not-a-hash', 'table', cfg())).toBe(true);
        expect(isRowHashStale('', 'table', cfg())).toBe(true);
    });

    it('is stale when the variant is missing from the stored hash', () => {
        const live = cfg();
        // Stored hash from a config that never knew about `table`.
        const stored = 'm=downscale|f=webp|q=82|header:1:300';
        expect(isRowHashStale(stored, 'table', live)).toBe(true);
    });

    it('is fresh for a variant the LIVE config does not know (legacy rows keep serving)', () => {
        const live = cfg();
        const stored = variantConfigHash(live).replace('header:1:300', 'header:1:300,legacy:1:120');
        expect(isRowHashStale(stored, 'legacy', live)).toBe(false);
    });
});
