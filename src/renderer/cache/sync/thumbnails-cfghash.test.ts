// Regression test: downscale-mode sweep writes must carry `__cfgHash`.
//
// The lazy resolver stamps `__cfgHash` on every blob row so a variant-config
// change (px / quality / format / enable) regenerates stale artwork. The
// downscale sweep wrote its rows WITHOUT the hash, so sweep-produced covers
// were treated as permanently fresh — config changes never took effect for
// them until a manual cache clear.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { variantConfigHash } from '/@/renderer/cache/variant-config';

const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string =>
        Array.isArray(key) ? JSON.stringify(key) : String(key);
    const thumbnailsTable = {
        get: vi.fn(async (key: unknown) => store.get(keyOf(key))),
        put: vi.fn(async (row: any) => {
            store.set(keyOf([row.ItemId, row.Variant]), row);
        }),
        update: vi.fn(async () => undefined),
        where: vi.fn(() => ({
            equals: () => ({ toArray: async () => [] }),
        })),
    };
    const db = { thumbnails: thumbnailsTable };
    return { db, store, thumbnailsTable };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/variant-downscale-pool', () => ({
    downscaleVariantsPooled: vi.fn(
        async (_src: Blob, variants: { px: number; variant: string }[]) =>
            new Map(
                variants.map((v) => [
                    v.variant,
                    { blob: new Blob([new Uint8Array(64)]), format: 'webp' as const },
                ]),
            ),
    ),
}));

import { __thumbnailsSweepInternals } from '/@/renderer/cache/sync/thumbnails';

const CFG = {
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
} as any;

const TEMPLATE = {
    credentials: undefined,
    headers: undefined,
    urlAfter: '/Images/Primary?width=1024',
    urlBefore: 'https://server.example/Items/',
};

const PENDING = {
    downscaleVariants: [
        { px: 80, variant: 'table' },
        { px: 300, variant: 'itemCard' },
    ],
    itemId: 'abc',
    itemType: 'album',
    kind: 'album',
    px: 300,
} as any;

beforeEach(() => {
    mocks.store.clear();
    globalThis.fetch = vi.fn(
        async () =>
            ({
                blob: async () => new Blob([new Uint8Array(2048)]),
                headers: { get: () => 'image/jpeg' },
                ok: true,
                status: 200,
            }) as unknown as Response,
    ) as unknown as typeof fetch;
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('downscale sweep __cfgHash stamping', () => {
    it('stamps every produced variant row with the live config hash', async () => {
        const signal = new AbortController().signal;

        await __thumbnailsSweepInternals.fetchDownscaleUnit(PENDING, TEMPLATE, CFG, signal);

        const expected = variantConfigHash(CFG);
        const tableRow = mocks.store.get(JSON.stringify(['abc', 'table']));
        const cardRow = mocks.store.get(JSON.stringify(['abc', 'itemCard']));
        expect(tableRow).toBeTruthy();
        expect(cardRow).toBeTruthy();
        expect(tableRow.__cfgHash).toBe(expected);
        expect(cardRow.__cfgHash).toBe(expected);
    });
});
