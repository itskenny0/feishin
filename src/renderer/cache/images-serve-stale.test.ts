// Serve-stale-while-revalidate for the display path.
//
// REGRESSION (device, 2026-06-10): a stale-config row made the display path
// DROP its Dexie hit and block on a network refetch — against a slow server
// every page visit visibly re-loaded its covers. A stale row is still a
// perfectly good cover; it must paint instantly while the exact bucket
// regenerates in the background. Only the sweep / background-generate path
// (`_skipBlobUrl`) refetches stale rows in-line (that IS the regeneration).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const LIVE_VARIANTS = {
        format: 'webp',
        mode: 'downscale',
        quality: 82,
        variants: {
            fullScreen: { enabled: false, px: 0 },
            header: { enabled: true, px: 300 },
            itemCard: { enabled: true, px: 300 },
            sidebar: { enabled: false, px: 400 },
            table: { enabled: true, px: 80 },
        },
    };
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string =>
        Array.isArray(key) ? JSON.stringify(key) : String(key);
    const thumbnailsTable = {
        get: vi.fn(async (key: unknown) => store.get(keyOf(key))),
        put: vi.fn(async (row: any) => {
            store.set(keyOf([row.ItemId, row.Variant]), row);
        }),
        update: vi.fn(async (key: unknown, changes: any) => {
            const k = keyOf(key);
            const existing = store.get(k);
            if (existing) store.set(k, { ...existing, ...changes });
        }),
        where: vi.fn((index: string) => ({
            equals: (value: unknown) => ({
                toArray: async () =>
                    [...store.values()].filter((row: any) => (row as any)[index] === value),
            }),
        })),
    };
    return { db: { thumbnails: thumbnailsTable }, LIVE_VARIANTS, store, thumbnailsTable };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
    NO_ARTWORK_URL: 'feishin://no-artwork',
    registerThumbnailDegradedProbe: vi.fn(),
    registerThumbnailUrlCache: vi.fn(),
}));

const LIVE_VARIANTS = mocks.LIVE_VARIANTS;

vi.mock('/@/renderer/store/settings.store', () => ({
    DEFAULT_IMAGE_VARIANTS: mocks.LIVE_VARIANTS,
    useSettingsStore: {
        getState: () => ({ localCache: { imageVariants: mocks.LIVE_VARIANTS } }),
    },
}));

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';

import { imageVariantsInternals, resolveThumbnail } from '/@/renderer/cache/images';
import { variantConfigHash } from '/@/renderer/cache/variant-config';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

let urlCounter = 0;

beforeEach(() => {
    urlCounter = 0;
    mocks.store.clear();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.clearAllMocks();
});

const okResponse = (bytes = 8192) =>
    ({
        blob: async () => new Blob([new Uint8Array(bytes)]),
        headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/webp' : null),
        },
        ok: true,
        status: 200,
    }) as unknown as Response;

const seedRow = (itemId: string, variant: string, cfgHash: string): Blob => {
    const blob = new Blob([new Uint8Array(4096)]);
    mocks.store.set(JSON.stringify([itemId, variant]), {
        __cachedAt: Date.now(),
        __cfgHash: cfgHash,
        Blob: blob,
        ByteSize: blob.size,
        Format: 'webp',
        ItemId: itemId,
        LastUsed: Date.now(),
        Size: 80,
        Variant: variant,
    });
    return blob;
};

const hashWith = (
    over: (cfg: {
        format: string;
        mode: string;
        quality: number;
        variants: Record<string, { enabled: boolean; px: number }>;
    }) => void,
): string => {
    const cfg = JSON.parse(JSON.stringify(LIVE_VARIANTS));
    over(cfg);
    return variantConfigHash(cfg as LocalCacheImageVariants);
};

describe('resolveThumbnail — stale rows on the display path', () => {
    it('a row differing only in another variant enabled bit is a plain hit (no fetch)', async () => {
        // Written before 4cab184c7 flipped the fullScreen default.
        const oldHash = hashWith((cfg) => {
            cfg.variants.fullScreen.enabled = true;
        });
        const blob = seedRow('abc', 'table', oldHash);
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(blob);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(scheduleSpy).not.toHaveBeenCalled();
        scheduleSpy.mockRestore();
    });

    it('a genuinely stale row (px changed) is served INSTANTLY and regenerates in background', async () => {
        const oldHash = hashWith((cfg) => {
            cfg.variants.table.px = 60; // live is 80
        });
        const blob = seedRow('abc', 'table', oldHash);
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        // Stale blob served immediately — NO awaited network fetch in the
        // paint path.
        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(blob);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        // The exact bucket regenerates in the background.
        expect(scheduleSpy).toHaveBeenCalledWith('abc', 'table', expect.anything());
        scheduleSpy.mockRestore();
    });

    it('the sweep/_skipBlobUrl path still refetches stale rows in-line', async () => {
        const oldHash = hashWith((cfg) => {
            cfg.variants.table.px = 60;
        });
        seedRow('abc', 'table', oldHash);
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const row = mocks.store.get(JSON.stringify(['abc', 'table']));
        expect(row.__cfgHash).toBe(variantConfigHash(LIVE_VARIANTS as LocalCacheImageVariants));
    });
});

describe('resolveThumbnail — contradictory 404 markers', () => {
    // Device, 2026-06-10: a 7-day 404 marker for [item, fullScreen] (written
    // during a flaky-server window) silently fed the fullscreen player the
    // no-artwork placeholder — while the SAME item's table variant held a
    // real cover. A marker contradicted by a sibling blob is bogus: ignore
    // it, serve the fallback, and refetch the exact bucket.
    it('serves the sibling fallback and refetches when a marker contradicts a cached blob', async () => {
        // Fresh 404 marker for fullScreen…
        mocks.store.set(JSON.stringify(['abc', 'fullScreen']), {
            __cachedAt: Date.now(),
            Blob: undefined,
            ByteSize: 0,
            ItemId: 'abc',
            LastUsed: Date.now(),
            MissAt: Date.now(),
            Size: 0,
            Variant: 'fullScreen',
        });
        // …while the table variant has a real cover.
        const tableBlob = seedRow('abc', 'table', variantConfigHash(LIVE_VARIANTS as never));

        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'fullScreen', RAW_URL);

        // NOT the no-artwork sentinel — the sibling cover serves as fallback.
        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(tableBlob);
        scheduleSpy.mockRestore();
    });

    it('the sweep path refetches through a contradicted marker (marker busted)', async () => {
        mocks.store.set(JSON.stringify(['abc', 'fullScreen']), {
            __cachedAt: Date.now(),
            Blob: undefined,
            ByteSize: 0,
            ItemId: 'abc',
            LastUsed: Date.now(),
            MissAt: Date.now(),
            Size: 0,
            Variant: 'fullScreen',
        });
        seedRow('abc', 'table', variantConfigHash(LIVE_VARIANTS as never));
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'fullScreen', RAW_URL, { _skipBlobUrl: true });

        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        const row = mocks.store.get(JSON.stringify(['abc', 'fullScreen']));
        expect(row.Blob).toBeTruthy();
        expect(row.MissAt).toBeUndefined();
    });

    it('honors a marker when NO sibling blob exists (genuine no-artwork)', async () => {
        mocks.store.set(JSON.stringify(['abc', 'table']), {
            __cachedAt: Date.now(),
            Blob: undefined,
            ByteSize: 0,
            ItemId: 'abc',
            LastUsed: Date.now(),
            MissAt: Date.now(),
            Size: 80,
            Variant: 'table',
        });
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        expect(out).toBe('feishin://no-artwork');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });
});
