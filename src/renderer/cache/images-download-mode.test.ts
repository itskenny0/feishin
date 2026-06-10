// Regression tests for DOWNLOAD-mode thumbnail sizing.
//
// In `localCache.imageVariants.mode === 'download'` every variant is fetched
// straight from the server at the variant's configured px. The resolver used
// to override whatever px the caller (or the sweep) baked into the URL with
// `rewriteUrlToCacheSize` (= MAX_CACHE_SIZE 1024), so EVERY variant — the 80px
// table bucket included — was fetched and stored at 1024px under its variant
// key, and the row's `Size` metadata lied (always 1024), breaking
// nearestLargerVariant fallback selection.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string => {
        if (Array.isArray(key)) return JSON.stringify(key);
        return String(key);
    };
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
    const db = { thumbnails: thumbnailsTable };
    // Mutable so individual tests can flip the mode.
    const cfg = {
        format: 'webp' as const,
        mode: 'download' as 'download' | 'downscale',
        quality: 82,
        variants: {
            fullScreen: { enabled: true, px: 0 },
            header: { enabled: true, px: 300 },
            itemCard: { enabled: true, px: 300 },
            sidebar: { enabled: false, px: 400 },
            table: { enabled: true, px: 80 },
        },
    };
    return { cfg, db, store, thumbnailsTable };
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
    DEFAULT_IMAGE_VARIANTS: mocks.cfg,
    useSettingsStore: {
        getState: () => ({ localCache: { imageVariants: mocks.cfg } }),
    },
}));

import { MAX_CACHE_SIZE, resolveThumbnail } from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

const okResponse = (bytes = 8192) =>
    ({
        blob: async () => new Blob([new Uint8Array(bytes)]),
        headers: {
            get: (name: string) => (name.toLowerCase() === 'content-type' ? 'image/jpeg' : null),
        },
        ok: true,
        status: 200,
    }) as unknown as Response;

const notFoundResponse = () =>
    ({
        blob: async () => new Blob([]),
        headers: { get: () => null },
        ok: false,
        status: 404,
    }) as unknown as Response;

const fetchedWidth = (call: number = 0): null | string => {
    const url = (globalThis.fetch as any).mock.calls[call][0] as string;
    return new URL(url).searchParams.get('width');
};

let urlCounter = 0;

beforeEach(() => {
    urlCounter = 0;
    mocks.cfg.mode = 'download';
    mocks.store.clear();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('resolveThumbnail — download-mode per-variant sizing', () => {
    it('fetches and records the variant px in download mode (lazy path)', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'table', RAW_URL);

        // table is configured at 80px — the fetch must NOT balloon to 1024
        expect(fetchedWidth()).toBe('80');
        const row = mocks.store.get(JSON.stringify(['abc', 'table']));
        expect(row.Size).toBe(80);
    });

    it('honours an explicit targetPx option (sweep path)', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'sidebar', RAW_URL, { targetPx: 400 });

        expect(fetchedWidth()).toBe('400');
        const row = mocks.store.get(JSON.stringify(['abc', 'sidebar']));
        expect(row.Size).toBe(400);
    });

    it('strips size params for a px-0 (original) variant in download mode', async () => {
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'fullScreen', RAW_URL);

        expect(fetchedWidth()).toBeNull();
        const row = mocks.store.get(JSON.stringify(['abc', 'fullScreen']));
        expect(row.Size).toBe(0);
    });

    it('writes the 404 miss marker with the variant px in download mode', async () => {
        globalThis.fetch = vi.fn(async () => notFoundResponse()) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'table', RAW_URL);

        const row = mocks.store.get(JSON.stringify(['abc', 'table']));
        expect(row.MissAt).toBeTruthy();
        expect(row.Size).toBe(80);
    });

    it('keeps the historical MAX_CACHE_SIZE fetch in downscale mode', async () => {
        mocks.cfg.mode = 'downscale';
        globalThis.fetch = vi.fn(async () => okResponse()) as unknown as typeof fetch;

        await resolveThumbnail('xyz', 'table', RAW_URL);

        expect(fetchedWidth()).toBe(String(MAX_CACHE_SIZE));
        const row = mocks.store.get(JSON.stringify(['xyz', 'table']));
        expect(row.Size).toBe(MAX_CACHE_SIZE);
    });
});
