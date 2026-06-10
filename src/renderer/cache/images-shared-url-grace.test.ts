// Regression tests for the shared-thumbnail-URL keep-alive.
//
// The refcounted object-URL cache used to revoke a URL the moment its last
// consumer released it. During scroll every unmounted cell dropped its cover's
// URL, so scrolling back (or returning to a route) re-paid the full async
// Dexie roundtrip and showed a skeleton for already-cached art. Released URLs
// now linger for a grace period (bounded by a cap) and can be re-acquired
// SYNCHRONOUSLY via peekThumbnailUrl — cached covers render instantly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string =>
        Array.isArray(key) ? JSON.stringify(key) : String(key);
    const thumbnailsTable = {
        bulkGet: vi.fn(async (keys: unknown[]) => keys.map((key) => store.get(keyOf(key)))),
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

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
    NO_ARTWORK_URL: 'feishin://no-artwork',
    registerThumbnailUrlCache: vi.fn(),
}));

vi.mock('/@/renderer/store/settings.store', () => ({
    DEFAULT_IMAGE_VARIANTS: {
        format: 'webp',
        mode: 'downscale',
        quality: 82,
        variants: {
            fullScreen: { enabled: true, px: 0 },
            header: { enabled: true, px: 300 },
            itemCard: { enabled: true, px: 300 },
            sidebar: { enabled: false, px: 400 },
            table: { enabled: true, px: 80 },
        },
    },
    useSettingsStore: {
        getState: () => ({
            localCache: {
                imageVariants: {
                    format: 'webp',
                    mode: 'downscale',
                    quality: 82,
                    variants: {
                        fullScreen: { enabled: true, px: 0 },
                        header: { enabled: true, px: 300 },
                        itemCard: { enabled: true, px: 300 },
                        sidebar: { enabled: false, px: 400 },
                        table: { enabled: true, px: 80 },
                    },
                },
            },
        }),
    },
}));

import {
    __resetSharedThumbnailUrls,
    acquireThumbnailUrl,
    peekThumbnailUrl,
    preloadThumbnailUrls,
    releaseThumbnailUrl,
} from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

const okResponse = () =>
    ({
        blob: async () => new Blob([new Uint8Array(1024)]),
        headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
        },
        ok: true,
        status: 200,
    }) as unknown as Response;

let urlCounter = 0;

beforeEach(() => {
    vi.useFakeTimers();
    // Reset module state FIRST: a sweep timer armed under a previous test's
    // (discarded) fake clock would otherwise block re-arming under this one.
    __resetSharedThumbnailUrls();
    urlCounter = 0;
    mocks.store.clear();
    globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
});

describe('shared thumbnail URL grace period', () => {
    it('keeps the URL alive after the last release and serves it synchronously via peek', async () => {
        const url = await acquireThumbnailUrl('abc', 'table', RAW_URL);
        expect(url).toMatch(/^blob:mock\//);

        releaseThumbnailUrl('abc', 'table');

        // Not revoked immediately — the grace window holds it.
        expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();

        // A synchronous peek re-acquires the SAME url with no async hop.
        const peeked = peekThumbnailUrl('abc', 'table');
        expect(peeked).toBe(url);

        // The peek took a real reference: even after the grace period the
        // URL must survive while referenced.
        vi.advanceTimersByTime(10 * 60_000);
        expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalled();
    });

    it('revokes the URL once the grace period expires with no consumers', async () => {
        // distinct item: module-level cache state persists across tests, and
        // the previous test deliberately leaves a live reference on 'abc'
        const url = await acquireThumbnailUrl('def', 'table', RAW_URL);
        releaseThumbnailUrl('def', 'table');

        vi.advanceTimersByTime(10 * 60_000);

        expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(url);
        expect(peekThumbnailUrl('def', 'table')).toBeUndefined();
    });

    it('peek returns undefined for unknown items', () => {
        expect(peekThumbnailUrl('nope', 'table')).toBeUndefined();
    });
});

describe('preloadThumbnailUrls — page-level bulk prime', () => {
    const seedRow = (id: string) => {
        mocks.store.set(JSON.stringify([id, 'itemCard']), {
            Blob: new Blob([new Uint8Array(64)]),
            ItemId: id,
            LastUsed: 0,
            Size: 300,
            Variant: 'itemCard',
        });
    };

    it('primes the shared cache with ONE bulkGet so cells peek synchronously', async () => {
        seedRow('p0');
        seedRow('p1');

        await preloadThumbnailUrls(['p0', 'p1', 'missing'], 'itemCard');

        expect(mocks.thumbnailsTable.bulkGet).toHaveBeenCalledTimes(1);
        expect(mocks.thumbnailsTable.get).not.toHaveBeenCalled();

        const a = peekThumbnailUrl('p0', 'itemCard');
        const b = peekThumbnailUrl('p1', 'itemCard');
        expect(a).toMatch(/^blob:mock\//);
        expect(b).toMatch(/^blob:mock\//);
        expect(a).not.toBe(b);
        // misses are left to the per-cell resolver
        expect(peekThumbnailUrl('missing', 'itemCard')).toBeUndefined();
    });

    it('skips ids whose shared URL is already live (no duplicate mint)', async () => {
        seedRow('p2');
        await preloadThumbnailUrls(['p2'], 'itemCard');
        const mintsAfterFirst = (globalThis.URL.createObjectURL as any).mock.calls.length;

        await preloadThumbnailUrls(['p2'], 'itemCard');

        expect((globalThis.URL.createObjectURL as any).mock.calls.length).toBe(mintsAfterFirst);
    });

    it('preloaded-but-never-used URLs are revoked after the grace window', async () => {
        seedRow('p3');
        await preloadThumbnailUrls(['p3'], 'itemCard');

        vi.advanceTimersByTime(10 * 60_000);

        expect(peekThumbnailUrl('p3', 'itemCard')).toBeUndefined();
    });
});
