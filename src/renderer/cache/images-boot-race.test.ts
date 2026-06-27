// Cold-boot cache-DB race for DISPLAY resolves.
//
// On a fresh app boot the lifecycle opens the active cache DB in a post-mount
// effect, queued behind first-launch schema migrations and the blocking
// first-sync gate. The very first wave of home covers fires its resolve before
// that open lands, so `getActiveCacheDb()` is still undefined and the bounded
// `awaitActiveCacheDb()` wait can TIME OUT before the DB activates.
//
// Regression guarded here: when that bounded wait loses the race, the resolver
// must NOT give up to the raw URL (which `useNativeImage` turns into a PERMANENT
// `notcached` placeholder — an already-cached cover triggers no sweep write, so
// no `feishin:thumbnail-upgraded` event ever re-resolves it). Instead it waits
// once more for the DB to activate and redoes the lookup against the now-ready
// DB, serving the cached cover. A genuine miss on a READY DB must still return
// PENDING_SYNC_URL (sync-only: never the network) — that path is unchanged.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks ------------------------------------------------------------
const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string => {
        if (Array.isArray(key)) return JSON.stringify(key);
        return String(key);
    };
    const thumbnailsTable = {
        bulkGet: vi.fn(async (keys: unknown[]) => keys.map((k) => store.get(keyOf(k)))),
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
    const db = { thumbnails: thumbnailsTable };
    // `getActiveCacheDb()` reads this; the cold-boot scenario leaves it
    // undefined so the SYNCHRONOUS check fails and the code must lean on the
    // awaiting wait. `awaitActiveCacheDb` is a per-test-scriptable vi.fn so a
    // test can model "the DB activates only on the SECOND wait".
    const active = { value: undefined as any };
    const awaitFn = vi.fn(async (_timeoutMs?: number) => active.value);
    const online = { value: true };
    // Declared INSIDE the hoisted block so it's initialized when the (hoisted)
    // settings-store mock factory's `getState` is first invoked — a sibling
    // store's async persist flush can call into the mock before a module-level
    // `const` would have run, tripping a temporal-dead-zone ReferenceError.
    const VARIANTS = {
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
    };
    return { active, awaitFn, db, online, store, thumbnailsTable, VARIANTS };
});

vi.mock('/@/renderer/cache/db', () => ({
    awaitActiveCacheDb: (timeoutMs?: number) => mocks.awaitFn(timeoutMs),
    getActiveCacheDb: () => mocks.active.value,
}));

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
    NO_ARTWORK_URL: 'feishin://no-artwork',
    PENDING_SYNC_URL: 'feishin://pending-sync',
    registerThumbnailDegradedProbe: vi.fn(),
    registerThumbnailUrlCache: vi.fn(),
}));

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => mocks.online.value,
    markServerReachable: vi.fn(),
    markServerUnreachable: vi.fn(),
    subscribeIsOnline: () => () => {},
}));

// CRITICAL for this suite: `localCache.enabled: true` so `isLocalCacheEnabled()`
// is TRUE and the resolver takes the awaiting boot-race path (not the
// synchronous `getActiveCacheDb()` branch other suites exercise).
vi.mock('/@/renderer/store/settings.store', () => ({
    DEFAULT_IMAGE_VARIANTS: mocks.VARIANTS,
    useSettingsStore: {
        getState: () => ({ localCache: { enabled: true, imageVariants: mocks.VARIANTS } }),
    },
}));

import {
    __resetSharedThumbnailUrls,
    acquireThumbnailUrl,
    imageVariantsInternals,
    resolveThumbnail,
} from '/@/renderer/cache/images';

const PENDING_SYNC_URL = 'feishin://pending-sync';
const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

let urlCounter = 0;

const seedRow = (itemId: string, variant: string, px: number, blob?: Blob): Blob => {
    const b = blob ?? new Blob([new Uint8Array(2048)]);
    mocks.store.set(JSON.stringify([itemId, variant]), {
        __cachedAt: Date.now(),
        Blob: b,
        ByteSize: b.size,
        Format: 'jpeg',
        ItemId: itemId,
        LastUsed: Date.now(),
        Size: px,
        Variant: variant,
    });
    return b;
};

beforeEach(() => {
    urlCounter = 0;
    mocks.online.value = true;
    mocks.active.value = undefined;
    mocks.store.clear();
    mocks.awaitFn.mockReset();
    // Default: the DB is already active when awaited (the common warm case).
    mocks.awaitFn.mockImplementation(async () => mocks.active.value);
    mocks.thumbnailsTable.get.mockClear();
    mocks.thumbnailsTable.put.mockClear();
    mocks.thumbnailsTable.update.mockClear();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    globalThis.fetch = vi.fn(async () => {
        throw new Error('network must not be touched on the cache-hit boot-race path');
    }) as unknown as typeof fetch;
});

afterEach(() => {
    __resetSharedThumbnailUrls();
    vi.clearAllMocks();
});

describe('resolveThumbnail — cold-boot DB race', () => {
    it('does NOT permanently give up when the DB activates only AFTER the first bounded wait', async () => {
        // The cover IS cached, but the DB is not yet active at resolve time:
        // `getActiveCacheDb()` is undefined and the FIRST `awaitActiveCacheDb()`
        // times out (returns undefined). The DB then activates and the SECOND
        // wait catches it.
        const cardBlob = seedRow('abc', 'itemCard', 300);
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        mocks.awaitFn
            // First wait: lifecycle hasn't opened the DB yet — race lost.
            .mockImplementationOnce(async () => undefined)
            // DB activates; second wait returns it (and getActiveCacheDb agrees).
            .mockImplementationOnce(async () => {
                mocks.active.value = mocks.db;
                return mocks.db;
            });

        const out = await resolveThumbnail('abc', 'itemCard', RAW_URL);

        // The cover resolved to its cached blob — NOT the raw URL (which would
        // become a permanent `notcached`), NOT the PENDING placeholder.
        expect(out).toMatch(/^blob:mock\//);
        expect(out).not.toBe(RAW_URL);
        expect(out).not.toBe(PENDING_SYNC_URL);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(cardBlob);
        // Re-awaited exactly because the first wait lost the race.
        expect(mocks.awaitFn).toHaveBeenCalledTimes(2);
        // Cache-only: the boot-race path never hits the network.
        expect(globalThis.fetch).not.toHaveBeenCalled();

        scheduleSpy.mockRestore();
    });

    it('acquireThumbnailUrl serves the cached blob (not raw / not pending) across the same race', async () => {
        const cardBlob = seedRow('abc', 'itemCard', 300);
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        mocks.awaitFn
            .mockImplementationOnce(async () => undefined)
            .mockImplementationOnce(async () => {
                mocks.active.value = mocks.db;
                return mocks.db;
            });

        const out = await acquireThumbnailUrl('abc', 'itemCard', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(out).not.toBe(RAW_URL);
        expect(out).not.toBe(PENDING_SYNC_URL);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(cardBlob);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        scheduleSpy.mockRestore();
    });

    it('adds ZERO extra waits when the DB is already active (warm path)', async () => {
        // Warm case: DB active from the start, first wait returns it. The
        // second-chance branch must be skipped (no redundant wait, no latency).
        mocks.active.value = mocks.db;
        seedRow('abc', 'itemCard', 300);

        const out = await resolveThumbnail('abc', 'itemCard', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(mocks.awaitFn).toHaveBeenCalledTimes(1);
    });

    it('a genuine miss on a READY DB still returns PENDING_SYNC_URL (sync-only, never the network)', async () => {
        // DB ready, nothing cached for this item in any variant: this is a TRUE
        // miss, not a boot-race. It must return the sync-only placeholder, not
        // the raw URL and not a network fetch — the second-chance wait must not
        // have masked this into a hit.
        mocks.active.value = mocks.db;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('missing-item', 'table', RAW_URL);

        expect(out).toBe(PENDING_SYNC_URL);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        scheduleSpy.mockRestore();
    });
});
