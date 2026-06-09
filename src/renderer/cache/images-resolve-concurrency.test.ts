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
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
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

const flushMicrotasks = async (rounds = 20) => {
    for (let i = 0; i < rounds; i += 1) {
        await Promise.resolve();
    }
};

describe('resolveThumbnail — bounded display-path concurrency', () => {
    it('starts at most 8 upstream fetches at once and hands slots over as they finish', async () => {
        const deferreds: Array<(r: Response) => void> = [];
        globalThis.fetch = vi.fn(
            () =>
                new Promise<Response>((resolve) => {
                    deferreds.push(resolve);
                }),
        ) as unknown as typeof fetch;

        const ok = () =>
            ({
                blob: async () => new Blob([new Uint8Array(64)]),
                headers: { get: () => 'image/jpeg' },
                ok: true,
                status: 200,
            }) as unknown as Response;

        const all = Array.from({ length: 20 }, (_, i) =>
            resolveThumbnail(`item-${i}`, 'itemCard', RAW_URL),
        );
        await flushMicrotasks();

        // Only the first window of fetches may be in flight.
        expect((globalThis.fetch as any).mock.calls.length).toBe(8);

        // Completing one resolve frees its slot for the next queued task.
        deferreds[0](ok());
        await flushMicrotasks();
        expect((globalThis.fetch as any).mock.calls.length).toBe(9);

        // Drain the rest so nothing leaks into other tests.
        for (let i = 1; i < deferreds.length; i += 1) deferreds[i](ok());
        await flushMicrotasks(60);
        while (deferreds.length < 20) {
            await flushMicrotasks(10);
            for (let i = 0; i < deferreds.length; i += 1) deferreds[i]?.(ok());
        }
        await Promise.all(all);
    });
});
