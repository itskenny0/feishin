// Tests for the variant cache's eviction coverage + config-hash staleness.
//
// Both concerns run against a REAL fake-indexeddb Dexie so the compound
// `[ItemId+Variant]` primary key (schema v12) is actually exercised — a single
// item now spreads its cover across several variant rows.
//
//  1. Eviction (cachedBytes / evict): byte accounting must sum ALL variant
//     rows of an item, and the LRU pass must delete each row by its compound
//     key (the old single-`ItemId` delete silently no-ops under v12). The
//     `is-electron` mock returns false so the quota cap engages.
//
//  2. Config-hash staleness: the resolver stamps the current
//     `variantConfigHash` on every blob row at write time, then treats a row
//     whose stored hash differs from the live config's hash as stale and
//     regenerates it (re-fetch) instead of serving the out-of-date cover.
//     Legacy rows without a stored hash are honoured (no upgrade stampede).

import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Quota-capped platform (non-Electron) so evict() doesn't early-return.
vi.mock('is-electron', () => ({
    default: () => false,
}));

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
    NO_ARTWORK_URL: 'feishin://no-artwork',
    registerThumbnailDegradedProbe: vi.fn(),
    registerThumbnailUrlCache: vi.fn(),
}));

import { getActiveCacheDb, type LibraryCacheDb, openCacheDb } from '/@/renderer/cache/db';
import { cachedBytes, evict } from '/@/renderer/cache/eviction';
import { imageVariantsInternals, resolveThumbnail } from '/@/renderer/cache/images';
import { variantConfigHash } from '/@/renderer/cache/variant-config';
import { DEFAULT_IMAGE_VARIANTS, useSettingsStore } from '/@/renderer/store/settings.store';

const SERVER = 'evict-server';
const USER = 'evict-user';
const dbName = `feishin-cache:${SERVER}:${USER}`;

const putVariant = async (
    db: LibraryCacheDb,
    itemId: string,
    variant: string,
    bytes: number,
    lastUsed: number,
    extra?: Partial<{ __cfgHash: string }>,
): Promise<void> => {
    await db.thumbnails.put({
        __cachedAt: lastUsed,
        Blob: new Blob([new Uint8Array(bytes)]),
        ByteSize: bytes,
        Etag: undefined,
        Format: 'webp',
        ItemId: itemId,
        LastUsed: lastUsed,
        MissAt: undefined,
        Size: variant === 'fullScreen' ? 0 : 300,
        Variant: variant,
        ...extra,
    } as never);
};

let urlCounter = 0;

beforeEach(async () => {
    await Dexie.delete(dbName);
    useSettingsStore.getState().actions.setLocalCache({ capacityBytes: 0 });
    urlCounter = 0;
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
    await Dexie.delete(dbName);
    vi.restoreAllMocks();
    vi.clearAllMocks();
});

describe('variant eviction (cachedBytes + LRU evict)', () => {
    it('cachedBytes sums every variant row of one item', async () => {
        const db = await openCacheDb(SERVER, USER);
        expect(db).toBeDefined();
        const now = Date.now();
        await putVariant(db!, 'album-1', 'table', 1_000, now);
        await putVariant(db!, 'album-1', 'itemCard', 5_000, now);
        await putVariant(db!, 'album-1', 'fullScreen', 50_000, now);

        expect(await cachedBytes()).toBe(56_000);
    });

    it('LRU evict removes the oldest variant rows first (by LastUsed)', async () => {
        const db = await openCacheDb(SERVER, USER);
        expect(db).toBeDefined();
        const base = Date.now();
        await putVariant(db!, 'old', 'fullScreen', 600_000, base - 30_000);
        await putVariant(db!, 'mid', 'fullScreen', 600_000, base - 20_000);
        await putVariant(db!, 'new', 'fullScreen', 600_000, base - 10_000);

        // Total is 1.8 MB. A 1.5 MB cap means freeing 0.3 MB — dropping just
        // the single oldest 0.6 MB row brings usage to 1.2 MB (under cap), so
        // only 'old' is evicted and the two newer rows survive.
        useSettingsStore.getState().actions.setLocalCache({ capacityBytes: 1_500_000 });

        await evict();

        const live = getActiveCacheDb();
        expect(await live!.thumbnails.get(['old', 'fullScreen'])).toBeUndefined();
        expect(await live!.thumbnails.get(['mid', 'fullScreen'])).toBeDefined();
        expect(await live!.thumbnails.get(['new', 'fullScreen'])).toBeDefined();
    });

    it('evict deletes by the compound [ItemId+Variant] key (no orphaned rows)', async () => {
        const db = await openCacheDb(SERVER, USER);
        expect(db).toBeDefined();
        // Older than the 7-day phase-1 cutoff so phase 1 exercises the delete.
        const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
        await putVariant(db!, 'album-x', 'table', 700_000, old);
        await putVariant(db!, 'album-x', 'itemCard', 700_000, old);

        useSettingsStore.getState().actions.setLocalCache({ capacityBytes: 500_000 });

        await evict();

        const live = getActiveCacheDb();
        expect(await live!.thumbnails.get(['album-x', 'table'])).toBeUndefined();
        expect(await live!.thumbnails.get(['album-x', 'itemCard'])).toBeUndefined();
        expect(await live!.thumbnails.count()).toBe(0);
    });
});

describe('resolveThumbnail — config-hash staleness', () => {
    const RAW_URL = 'https://server.example/Items/abc/Images/Primary?width=1024&height=1024';

    const jpegResponse = (bytes = 8192) =>
        ({
            blob: async () => new Blob([new Uint8Array(bytes)]),
            headers: {
                get: (name: string) =>
                    name.toLowerCase() === 'content-type' ? 'image/jpeg' : null,
            },
            ok: true,
            status: 200,
        }) as unknown as Response;

    beforeEach(async () => {
        // Resolver reads the live config; ensure the canonical defaults.
        useSettingsStore
            .getState()
            .actions.setLocalCache({ imageVariants: DEFAULT_IMAGE_VARIANTS });
        await openCacheDb(SERVER, USER);
    });

    it('stamps the current config hash on a freshly-written row', async () => {
        globalThis.fetch = vi.fn(async () => jpegResponse()) as unknown as typeof fetch;

        // Rows are written by the sweep (`_skipBlobUrl`); the display path is
        // now cache-only and never fetches/populates on demand.
        await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });

        const row = await getActiveCacheDb()!.thumbnails.get(['abc', 'table']);
        expect(row).toBeTruthy();
        expect((row as never as { __cfgHash?: string }).__cfgHash).toBe(
            variantConfigHash(DEFAULT_IMAGE_VARIANTS),
        );
    });

    it('serves a row whose stored hash matches the live config (cache HIT)', async () => {
        const db = getActiveCacheDb()!;
        await putVariant(db, 'abc', 'table', 4096, Date.now(), {
            __cfgHash: variantConfigHash(DEFAULT_IMAGE_VARIANTS),
        });
        globalThis.fetch = vi.fn(async () => jpegResponse()) as unknown as typeof fetch;

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(
            (globalThis.fetch as never as { mock: { calls: unknown[] } }).mock.calls.length,
        ).toBe(0);
    });

    it('serves a stale-config row INSTANTLY and schedules a background regenerate', async () => {
        // Serve-stale-while-revalidate: the display path never blocks on a
        // refetch for a stale row (that made covers visibly re-load on every
        // page against a slow server) — it paints the stale blob and lets the
        // debounced background generate replace the row.
        const db = getActiveCacheDb()!;
        await putVariant(db, 'abc', 'table', 4096, Date.now(), {
            __cfgHash: 'stale-hash-from-an-older-config',
        });

        globalThis.fetch = vi.fn(async () => jpegResponse()) as unknown as typeof fetch;
        const scheduleSpy = vi
            .spyOn(imageVariantsInternals, 'scheduleVariantGenerate')
            .mockImplementation(() => {});

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(
            (globalThis.fetch as never as { mock: { calls: unknown[] } }).mock.calls.length,
        ).toBe(0);
        expect(scheduleSpy).toHaveBeenCalledWith('abc', 'table', expect.anything());
        scheduleSpy.mockRestore();
    });

    it('regenerates a stale-config row in-line on the sweep path (_skipBlobUrl)', async () => {
        const db = getActiveCacheDb()!;
        await putVariant(db, 'abc', 'table', 4096, Date.now(), {
            __cfgHash: 'stale-hash-from-an-older-config',
        });

        const freshBlob = new Blob([new Uint8Array(9000)]);
        globalThis.fetch = vi.fn(
            async () =>
                ({
                    blob: async () => freshBlob,
                    headers: {
                        get: (name: string) =>
                            name.toLowerCase() === 'content-type' ? 'image/webp' : null,
                    },
                    ok: true,
                    status: 200,
                }) as unknown as Response,
        ) as unknown as typeof fetch;

        await resolveThumbnail('abc', 'table', RAW_URL, { _skipBlobUrl: true });

        expect(
            (globalThis.fetch as never as { mock: { calls: unknown[] } }).mock.calls.length,
        ).toBe(1);
        const row = await getActiveCacheDb()!.thumbnails.get(['abc', 'table']);
        expect((row as never as { __cfgHash?: string }).__cfgHash).toBe(
            variantConfigHash(DEFAULT_IMAGE_VARIANTS),
        );
        expect(row!.ByteSize).toBe(9000);
    });

    it('does NOT treat a legacy row without a stored hash as stale', async () => {
        const db = getActiveCacheDb()!;
        // No __cfgHash on the row (pre-config-hash write). Still a valid cover.
        await putVariant(db, 'abc', 'table', 4096, Date.now());
        globalThis.fetch = vi.fn(async () => jpegResponse()) as unknown as typeof fetch;

        const out = await resolveThumbnail('abc', 'table', RAW_URL);

        expect(out).toMatch(/^blob:mock\//);
        expect(
            (globalThis.fetch as never as { mock: { calls: unknown[] } }).mock.calls.length,
        ).toBe(0);
    });
});
