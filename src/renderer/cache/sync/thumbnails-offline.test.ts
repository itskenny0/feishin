// Regression: the thumbnail sweep PAUSES while offline (no fetches, no failure
// recording, workers idle without burning the queue) and RESUMES from the same
// cursor when connectivity returns. Surfaces 'paused (offline)' in the sweep
// progress so the dashboard doesn't show a frozen counter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    return {
        listeners,
        online: true,
        setOnline(v: boolean) {
            this.online = v;
            for (const cb of [...listeners]) cb();
        },
    };
});

const LIVE_VARIANTS = vi.hoisted(() => ({
    format: 'webp',
    mode: 'download',
    quality: 82,
    variants: {
        fullScreen: { enabled: false, px: 0 },
        header: { enabled: false, px: 300 },
        itemCard: { enabled: false, px: 300 },
        sidebar: { enabled: false, px: 400 },
        table: { enabled: true, px: 80 },
    },
}));

const mocks = vi.hoisted(() => {
    const store = new Map<string, any>();
    const keyOf = (key: unknown): string =>
        Array.isArray(key) ? JSON.stringify(key) : String(key);
    const thumbnailsTable = {
        count: vi.fn(async () => store.size),
        get: vi.fn(async (key: unknown) => store.get(keyOf(key))),
        put: vi.fn(async (row: any) => {
            store.set(keyOf([row.ItemId, row.Variant]), row);
        }),
        toCollection: () => ({
            primaryKeys: async () => [...store.keys()].map((k) => JSON.parse(k)),
        }),
        where: vi.fn(() => ({
            above: () => ({ count: async () => 0, toArray: async () => [] }),
        })),
    };
    const albumIds = ['al1', 'al2', 'al3'];
    const keyColl = (ids: string[]) => ({
        toCollection: () => ({ primaryKeys: async () => ids }),
    });
    const db = {
        albums: keyColl(albumIds),
        artists: keyColl([]),
        playlists: keyColl([]),
        thumbnails: thumbnailsTable,
    };
    return { albumIds, db, store, thumbnailsTable };
});

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => net.online,
    subscribeIsOnline: (cb: () => void) => {
        net.listeners.add(cb);
        return () => net.listeners.delete(cb);
    },
}));

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/eviction', () => ({
    evict: vi.fn(async () => undefined),
    MAX_CACHE_SIZE: 1024,
}));

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getImageRequest: () => ({
                credentials: undefined,
                headers: undefined,
                url: 'https://server.example/Items/__FEISHIN_ID_PLACEHOLDER__/Images/Primary?width=1024',
            }),
        },
    },
}));

vi.mock('/@/renderer/cache/images', () => ({
    MAX_CACHE_SIZE: 1024,
    resolveThumbnailWithBytes: vi.fn(async () => ({ bytes: 2048, noArtwork: undefined, url: 'x' })),
    rewriteUrlToVariantSize: (url: string) => url,
}));

vi.mock('/@/renderer/store', () => ({
    DEFAULT_IMAGE_VARIANTS: LIVE_VARIANTS,
    useSettingsStore: {
        getState: () => ({ localCache: { imageVariants: LIVE_VARIANTS, thumbnailConcurrency: 2 } }),
    },
}));

import { resolveThumbnailWithBytes } from '/@/renderer/cache/images';
import { useCacheStore } from '/@/renderer/cache/store';
import { runThumbnailsSweep } from '/@/renderer/cache/sync/thumbnails';

const resolverMock = vi.mocked(resolveThumbnailWithBytes);

const SERVER = { id: 'srv1', url: 'https://server.example' } as any;

beforeEach(() => {
    net.online = true;
    net.listeners.clear();
    mocks.store.clear();
    useCacheStore.setState((s) => ({ ...s, sweep: undefined }) as never);
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('thumbnails sweep connectivity pause/resume (d)', () => {
    it('parks while offline then completes on reconnect, no failures recorded', async () => {
        net.online = false;

        const sweepPromise = runThumbnailsSweep({ signal: new AbortController().signal }, SERVER);

        // Let the workers reach the offline park. NO resolver call (= no
        // network fetch) should have fired while offline.
        await new Promise((r) => setTimeout(r, 30));
        expect(resolverMock).not.toHaveBeenCalled();
        const parked = useCacheStore.getState().sweep;
        expect(parked?.progress.paused).toBe('offline');

        // Reconnect → the parked workers wake and drain the queue.
        net.setOnline(true);
        await sweepPromise;

        // All 3 album covers (table variant) were resolved exactly once each
        // — the cursor resumed cleanly, no item skipped or double-fetched.
        expect(resolverMock).toHaveBeenCalledTimes(3);
        // Sweep cleared on completion.
        expect(useCacheStore.getState().sweep).toBeUndefined();
    });

    it('does not leave the connectivity subscription registered after completion', async () => {
        net.online = true;
        await runThumbnailsSweep({ signal: new AbortController().signal }, SERVER);
        // The sweep's subscribeIsOnline listener must be torn down.
        expect(net.listeners.size).toBe(0);
    });
});
