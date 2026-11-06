// In-flight dedup in the thumbnail resolver:
//  - A display resolve served from the fs fast path (a file-backed cover, the
//    Android default) must release its dedup entry. It used to return before
//    the try/finally that deletes it, so the entry stuck for the session and
//    every later sweep / background regenerate for that cover joined the
//    settled display task instead of fetching - a stale fs cover never
//    refreshed.
//  - A fetching caller (the sweep) must never join a cache-only display task,
//    which skips the fetch and settles with zero bytes.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string => JSON.stringify(key);
    const thumbnails = {
        get: vi.fn(async (key: unknown) => store.get(keyOf(key))),
        put: vi.fn(async (row: any) => {
            store.set(keyOf([row.ItemId, row.Variant]), row);
        }),
        update: vi.fn(async () => 1),
        where: vi.fn((index: string) => ({
            equals: (value: unknown) => ({
                toArray: async () => [...store.values()].filter((row: any) => row[index] === value),
            }),
        })),
    };
    const db = {
        thumbnails,
        transaction: vi.fn(async (...args: unknown[]) =>
            (args[args.length - 1] as () => unknown)(),
        ),
    };
    const cfg = {
        format: 'webp' as const,
        mode: 'download' as const,
        quality: 82,
        variants: {
            fullScreen: { enabled: true, px: 1080 },
            header: { enabled: false, px: 300 },
            itemCard: { enabled: true, px: 300 },
            sidebar: { enabled: true, px: 400 },
            table: { enabled: true, px: 80 },
        },
    };
    return { cfg, db, store };
});

vi.mock('/@/renderer/cache/db', () => ({
    awaitActiveCacheDb: async () => mocks.db,
    getActiveCacheDb: () => mocks.db,
}));
vi.mock('/@/renderer/cache/stats', () => ({ recordStat: vi.fn() }));
vi.mock('/@/renderer/cache/backends/active-backend', () => ({
    backendForRef: () => ({
        load: async () => new Blob([new Uint8Array(64)]),
        resolveUrl: (ref: { path: string }) => `file://${ref.path}`,
    }),
    getActiveBackend: () => ({
        id: 'idb',
        store: async (_ns: string, _key: string, blob: Blob) => ({ blob, kind: 'idb' }),
    }),
}));
vi.mock('/@/shared/components/image/use-native-image', () => ({
    NO_ARTWORK_URL: 'feishin://no-artwork',
    PENDING_SYNC_URL: 'feishin://pending-sync',
    registerThumbnailDegradedProbe: vi.fn(),
    registerThumbnailUrlCache: vi.fn(),
}));
vi.mock('/@/renderer/store/settings.store', () => ({
    DEFAULT_IMAGE_VARIANTS: mocks.cfg,
    useSettingsStore: {
        getState: () => ({ localCache: { enabled: true, imageVariants: mocks.cfg } }),
    },
}));

import {
    imageVariantsInternals,
    resolveThumbnail,
    resolveThumbnailWithBytes,
} from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=80&height=80';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.store.clear();
    globalThis.fetch = vi.fn(async () => ({
        blob: async () => new Blob([new Uint8Array(64)]),
        headers: { get: () => 'image/webp' },
        ok: true,
        status: 200,
    })) as unknown as typeof fetch;
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:mock/1');
});

describe('resolveThumbnail in-flight dedup', () => {
    it('releases the in-flight entry so the stale-cover regenerate still fetches', async () => {
        const regenerate = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => undefined);
        // A cover written under an older variant config (stale hash).
        mocks.store.set(JSON.stringify(['abc', 'table']), {
            __cachedAt: 0,
            __cfgHash: 'stale-config',
            Backend: 'capacitor-fs',
            ByteSize: 64,
            ItemId: 'abc',
            LastUsed: Date.now(),
            Path: '/covers/abc-table',
            Size: 80,
            Variant: 'table',
        });

        // Display: paints the stale file now and schedules the regenerate.
        expect(await resolveThumbnail('abc', 'table', RAW_URL)).toBe('file:///covers/abc-table');
        expect(regenerate).toHaveBeenCalledTimes(1);

        // The scheduled regenerate re-enters with `_skipBlobUrl` and must fetch.
        await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('a sweep fetch never joins a display resolve that skips the fetch', async () => {
        // Nothing cached: the display resolve is cache-only (placeholder, no
        // fetch). A sweep for the same cover landing while it is in flight must
        // still fetch instead of inheriting its zero-byte result.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        mocks.db.thumbnails.get.mockImplementationOnce(async (key: unknown) => {
            await gate;
            return mocks.store.get(JSON.stringify(key));
        });
        const display = resolveThumbnail('new', 'table', RAW_URL);
        await vi.waitFor(() => expect(mocks.db.thumbnails.get).toHaveBeenCalled());
        const sweep = resolveThumbnailWithBytes('new', 'table', RAW_URL, { targetPx: 80 });
        release();
        const swept = await sweep;
        await display;
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
        expect(swept.bytes).toBeGreaterThan(0);
    });
});
