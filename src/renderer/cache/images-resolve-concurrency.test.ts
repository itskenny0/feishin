// Regression test: display-path thumbnail resolves must be bounded.
//
// A grid mounting 50+ cells used to kick 50 concurrent resolver tasks — 50
// racing IndexedDB gets and, on a cold cache, 50 simultaneous network fetches
// + blob handling. The renderer visibly hung while the burst drained. The
// resolver now gates the heavy section behind a small concurrency window
// (LIFO, so the most recently requested — i.e. currently visible — covers
// win). Sweep-path resolves (_skipBlobUrl) bypass the gate; the sweep has its
// own worker pool.

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
    // Cache is mandatory now (sync-only): images.ts resolves the db via
    // awaitActiveCacheDb() on the enabled path, so the mock must provide it.
    awaitActiveCacheDb: async () => mocks.db,
    getActiveCacheDb: () => mocks.db,
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

import { __resetSharedThumbnailUrls, resolveThumbnail } from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/x/Images/Primary?width=300';

let urlCounter = 0;

beforeEach(() => {
    __resetSharedThumbnailUrls();
    urlCounter = 0;
    mocks.store.clear();
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('resolveThumbnail — cache-only display path', () => {
    // The original burst problem (a grid mounting 50 cells → 50 concurrent
    // upstream fetches) is now solved at the source: in a sync-only app the
    // display path NEVER fetches the remote on demand. A grid of un-cached
    // covers does zero network work and paints placeholders; the sweep
    // populates them. This is the regression guard for "covers feel
    // remote-downloaded even when cached".
    it('never fetches the remote on the display path; returns PENDING for un-cached covers', async () => {
        globalThis.fetch = vi.fn() as unknown as typeof fetch;

        const results = await Promise.all(
            Array.from({ length: 20 }, (_, i) =>
                resolveThumbnail(`item-${i}`, 'itemCard', RAW_URL),
            ),
        );

        // Zero upstream fetches — every cover came back as a pending placeholder.
        expect((globalThis.fetch as any).mock.calls.length).toBe(0);
        expect(results.every((r) => r === 'feishin://pending-sync')).toBe(true);
    });

    it('still fetches on the sweep/population path (_skipBlobUrl)', async () => {
        globalThis.fetch = vi.fn(
            async () =>
                ({
                    blob: async () => new Blob([new Uint8Array(64)]),
                    headers: { get: () => 'image/jpeg' },
                    ok: true,
                    status: 200,
                }) as unknown as Response,
        ) as unknown as typeof fetch;

        await resolveThumbnail('sweep-item', 'itemCard', RAW_URL, { _skipBlobUrl: true });

        expect((globalThis.fetch as any).mock.calls.length).toBe(1);
    });
});
