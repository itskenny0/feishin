// Degraded-cover upgrade plumbing.
//
// Device evidence (2026-06-10): the fullscreen player requested the
// `fullScreen` variant while the connectivity signal said "unreachable";
// the resolver served the only cached variant (a tiny `table` cover,
// insufficient) and the surface settled on it FOREVER — no upgrade when
// connectivity recovered. The cache layer must:
//   1. remember degraded serves (stale row / insufficient fallback),
//   2. regenerate them when connectivity returns,
//   3. announce the exact-bucket write (`feishin:thumbnail-upgraded`) so
//      surfaces re-resolve, and
//   4. invalidate the shared URL entry so the re-resolve doesn't re-adopt
//      the old degraded blob.
// Also: a SUCCESSFUL image fetch marks the server reachable again (image
// stalls flip it unreachable; successes must flip it back).

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
    const onlineListeners = new Set<() => void>();
    const net = {
        fireOnlineTransition: () => onlineListeners.forEach((cb) => cb()),
        markServerReachable: vi.fn(),
        markServerUnreachable: vi.fn(),
        online: true,
        onlineListeners,
    };
    return { db: { thumbnails: thumbnailsTable }, LIVE_VARIANTS, net, store, thumbnailsTable };
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

vi.mock('/@/renderer/store/settings.store', () => ({
    DEFAULT_IMAGE_VARIANTS: mocks.LIVE_VARIANTS,
    useSettingsStore: {
        getState: () => ({ localCache: { imageVariants: mocks.LIVE_VARIANTS } }),
    },
}));

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => mocks.net.online,
    markServerReachable: mocks.net.markServerReachable,
    markServerUnreachable: mocks.net.markServerUnreachable,
    subscribeIsOnline: (cb: () => void) => {
        mocks.net.onlineListeners.add(cb);
        return () => mocks.net.onlineListeners.delete(cb);
    },
}));

import type { LocalCacheImageVariants } from '/@/renderer/store/settings.store';

import {
    __resetSharedThumbnailUrls,
    acquireThumbnailUrl,
    imageVariantsInternals,
    peekThumbnailUrl,
    releaseThumbnailUrl,
    resolveThumbnail,
    wasServedDegraded,
} from '/@/renderer/cache/images';
import { variantConfigHash } from '/@/renderer/cache/variant-config';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

let urlCounter = 0;

beforeEach(() => {
    urlCounter = 0;
    mocks.store.clear();
    mocks.net.online = true;
    __resetSharedThumbnailUrls();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
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

const liveHash = () => variantConfigHash(mocks.LIVE_VARIANTS as LocalCacheImageVariants);

const seedRow = (itemId: string, variant: string, cfgHash: string, size = 80): Blob => {
    const blob = new Blob([new Uint8Array(4096)]);
    mocks.store.set(JSON.stringify([itemId, variant]), {
        __cachedAt: Date.now(),
        __cfgHash: cfgHash,
        Blob: blob,
        ByteSize: blob.size,
        Format: 'webp',
        ItemId: itemId,
        LastUsed: Date.now(),
        Size: size,
        Variant: variant,
    });
    return blob;
};

const staleTableHash = () => {
    const cfg = JSON.parse(JSON.stringify(mocks.LIVE_VARIANTS));
    cfg.variants.table.px = 60; // live is 80 → genuinely stale
    return variantConfigHash(cfg as LocalCacheImageVariants);
};

describe('degraded-serve bookkeeping', () => {
    it('a stale-served display hit is recorded; the exact write emits the upgrade event and clears it', async () => {
        seedRow('abc', 'table', staleTableHash());
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'table', RAW_URL);
        expect(wasServedDegraded('abc', 'table')).toBe(true);

        const events: Array<{ itemId: string; variant: string }> = [];
        const onUpgrade = (e: Event) =>
            events.push((e as CustomEvent<{ itemId: string; variant: string }>).detail);
        window.addEventListener('feishin:thumbnail-upgraded', onUpgrade);

        // The background generate (here run in-line) writes the exact bucket.
        await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });

        window.removeEventListener('feishin:thumbnail-upgraded', onUpgrade);
        expect(events).toContainEqual({ itemId: 'abc', variant: 'table' });
        expect(wasServedDegraded('abc', 'table')).toBe(false);
        scheduleSpy.mockRestore();
    });

    it('an OFFLINE insufficient fallback is recorded and regenerates when connectivity returns', async () => {
        mocks.net.online = false;
        // Only a tiny `table` cover cached for the item; the fullScreen
        // request can only be served degraded.
        seedRow('abc', 'table', liveHash());
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'fullScreen', RAW_URL);
        expect(out).toMatch(/^blob:mock\//); // degraded blob served
        expect(globalThis.fetch).not.toHaveBeenCalled(); // no doomed fetch
        expect(wasServedDegraded('abc', 'fullScreen')).toBe(true);
        expect(scheduleSpy).not.toHaveBeenCalled(); // offline: no generate yet

        // Connectivity returns → the pending degraded entries regenerate.
        mocks.net.online = true;
        mocks.net.fireOnlineTransition();
        expect(scheduleSpy).toHaveBeenCalledWith('abc', 'fullScreen', expect.anything());
        scheduleSpy.mockRestore();
    });

    it('a successful image fetch marks the server reachable', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        await resolveThumbnail('abc', 'table', RAW_URL);
        expect(mocks.net.markServerReachable).toHaveBeenCalled();
    });
});

describe('shared URL invalidation on upgrade', () => {
    it('the exact write invalidates the shared entry; a re-acquire mints the fresh blob', async () => {
        vi.useFakeTimers();
        seedRow('abc', 'table', staleTableHash());
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        // A consumer adopts the degraded cover through the shared cache.
        const oldUrl = await acquireThumbnailUrl('abc', 'table', RAW_URL);
        expect(oldUrl).toMatch(/^blob:mock\//);

        // Exact bucket regenerates (in-line stand-in for the background task).
        await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });

        // The shared entry for the degraded blob is gone — peek misses, and a
        // fresh acquire mints a NEW url from the fresh row.
        expect(peekThumbnailUrl('abc', 'table')).toBeUndefined();
        const newUrl = await acquireThumbnailUrl('abc', 'table', RAW_URL);
        expect(newUrl).toMatch(/^blob:mock\//);
        expect(newUrl).not.toBe(oldUrl);

        // The old consumer's release (carrying ITS url) revokes the orphaned
        // blob after the grace window — and never touches the new entry.
        releaseThumbnailUrl('abc', 'table', oldUrl);
        await vi.runOnlyPendingTimersAsync();
        expect(globalThis.URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
        expect(globalThis.URL.revokeObjectURL).not.toHaveBeenCalledWith(newUrl);
        scheduleSpy.mockRestore();
    });
});
