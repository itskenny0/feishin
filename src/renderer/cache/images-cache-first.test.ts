// Cache-first display resolves.
//
// The display path must never block on the network when a usable cover is
// already in Dexie:
//  - exact [itemId, variant] hit                  -> serve it (existing behaviour)
//  - miss, but a LARGER-OR-EQUAL variant cached   -> serve it immediately,
//    NO network fetch in the paint path; the exact variant is generated in
//    the background (debounced).
//  - miss, only a SMALLER variant cached, OFFLINE -> serve the smaller blob
//    immediately (an upscaled cover beats a hung fetch / broken image).
//  - miss, only a SMALLER variant cached, ONLINE  -> fetch the exact variant
//    (sharp wins when the network is healthy); the smaller blob remains the
//    post-failure fallback.
//
// Also covers the in-flight `_wantBlob` collision: a display acquire that
// lands while a sweep resolve for the same (item, variant) is in flight must
// receive the blob through the hand-off slot (one shared object URL), not
// fall back to the raw URL while leaking an orphan object URL.

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
    const online = { value: true };
    return { db, online, store, thumbnailsTable };
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

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => mocks.online.value,
    markServerReachable: vi.fn(),
    markServerUnreachable: vi.fn(),
    subscribeIsOnline: () => () => {},
}));

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
        getState: () => ({ localCache: { imageVariants: VARIANTS } }),
    },
}));

import {
    __resetSharedThumbnailUrls,
    acquireThumbnailUrl,
    imageVariantsInternals,
    resolveThumbnail,
} from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

let urlCounter = 0;

const seedRow = (itemId: string, variant: string, px: number, blob?: Blob) => {
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
    mocks.store.clear();
    mocks.thumbnailsTable.get.mockClear();
    mocks.thumbnailsTable.put.mockClear();
    mocks.thumbnailsTable.update.mockClear();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    __resetSharedThumbnailUrls();
    vi.clearAllMocks();
});

const okResponse = (bytes = 8192) =>
    ({
        blob: async () => new Blob([new Uint8Array(bytes)]),
        headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
        },
        ok: true,
        status: 200,
    }) as unknown as Response;

describe('resolveThumbnail — cache-first display resolves', () => {
    it('serves a cached LARGER variant with NO network fetch in the paint path', async () => {
        // itemCard (300px) cached; the table (80px) bucket is empty.
        const cardBlob = seedRow('abc', 'itemCard', 300);

        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(cardBlob);
        // The whole point: the display resolve never touched the network.
        expect(globalThis.fetch).not.toHaveBeenCalled();
        // The exact variant is produced out-of-band instead.
        expect(scheduleSpy).toHaveBeenCalledWith('abc', 'table', expect.anything());

        scheduleSpy.mockRestore();
    });

    it('serves an EQUAL-px cached variant without fetching', async () => {
        // header and itemCard are both 300px. itemCard cached, header requested.
        const cardBlob = seedRow('abc', 'itemCard', 300);
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'header', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(cardBlob);
        expect(globalThis.fetch).not.toHaveBeenCalled();

        scheduleSpy.mockRestore();
    });

    it('ONLINE with only a SMALLER variant cached still fetches the exact variant', async () => {
        // Only table (80px) cached; itemCard (300px) requested while online.
        seedRow('abc', 'table', 80);
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        const out = await resolveThumbnail('abc', 'itemCard', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        // Sharp wins online: the network fetch ran and the row landed.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.store.get(JSON.stringify(['abc', 'itemCard']))?.Blob).toBeInstanceOf(Blob);
    });

    it('OFFLINE with only a SMALLER variant cached serves it immediately, no fetch', async () => {
        mocks.online.value = false;
        const smallBlob = seedRow('abc', 'table', 80);
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'itemCard', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledWith(smallBlob);
        // Offline: the paint path must not attempt the network at all.
        expect(globalThis.fetch).not.toHaveBeenCalled();

        scheduleSpy.mockRestore();
    });

    it('OFFLINE with nothing cached resolves to the raw URL without fetching', async () => {
        mocks.online.value = false;
        globalThis.fetch = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        }) as unknown as typeof fetch;

        const out = await resolveThumbnail('nope', 'table', RAW_URL);

        expect(out).toBe(RAW_URL);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('sweep resolves (_skipBlobUrl) are NOT short-circuited by the fallback', async () => {
        // The sweep wants the exact variant persisted; a cached larger variant
        // must not satisfy it.
        seedRow('abc', 'itemCard', 300);
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        const out = await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });

        expect(out).toBe(RAW_URL); // sentinel for _skipBlobUrl callers
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(mocks.store.get(JSON.stringify(['abc', 'table']))?.Blob).toBeInstanceOf(Blob);
    });
});

describe('acquireThumbnailUrl — in-flight sweep collision', () => {
    it('adopts the blob from an in-flight sweep resolve instead of the raw URL', async () => {
        // A sweep-style resolve is mid-fetch when the display acquire lands.
        let releaseFetch: (() => void) | undefined;
        const fetchGate = new Promise<void>((resolve) => {
            releaseFetch = resolve;
        });
        globalThis.fetch = vi.fn(async () => {
            await fetchGate;
            return okResponse();
        }) as unknown as typeof fetch;

        const sweepPromise = resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });
        // Give the sweep task a tick to register in the in-flight map.
        await Promise.resolve();

        const acquirePromise = acquireThumbnailUrl('abc', 'table', RAW_URL);
        releaseFetch?.();
        const [, acquired] = await Promise.all([sweepPromise, acquirePromise]);

        // The display consumer gets the (shared, refcounted) blob URL minted
        // from the sweep's fetch — not the raw network URL.
        expect(acquired).toMatch(/^blob:mock\//);
        // Exactly one upstream fetch and exactly one object URL minted.
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);
    });
});
