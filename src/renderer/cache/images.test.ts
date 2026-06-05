// Unit tests for the shared, refcounted thumbnail object-URL cache added to
// images.ts. The goal of `acquireThumbnailUrl` / `releaseThumbnailUrl` is to
// hand every mounted consumer of the SAME item ONE shared blob: URL and to
// revoke it exactly once, when the last consumer releases it — rather than
// minting + revoking a fresh URL per mount during scroll.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks ------------------------------------------------------------
const mocks = vi.hoisted(() => {
    const thumbnailsTable = {
        get: vi.fn(),
        put: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
    };
    const db = { thumbnails: thumbnailsTable };
    return { db, thumbnailsTable };
});

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.db,
}));

vi.mock('/@/renderer/cache/stats', () => ({
    recordStat: vi.fn(),
}));

// The registration bridge into the shared hook is a no-op side effect for
// these tests.
vi.mock('/@/shared/components/image/use-native-image', () => ({
    registerThumbnailUrlCache: vi.fn(),
}));

import { acquireThumbnailUrl, releaseThumbnailUrl } from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary';

let urlCounter = 0;
const revoked: string[] = [];

beforeEach(() => {
    urlCounter = 0;
    revoked.length = 0;
    mocks.thumbnailsTable.get.mockReset();
    mocks.thumbnailsTable.update.mockReset().mockResolvedValue(undefined);
    // Deterministic, unique blob: URLs so we can assert reuse vs churn.
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn((u: string) => {
        revoked.push(u);
    });
});

afterEach(() => {
    vi.clearAllMocks();
});

const cachedRow = () => ({
    Blob: new Blob(['fake-image-bytes']),
    ItemId: 'abc',
    LastUsed: Date.now(),
    Size: 1024,
});

describe('acquireThumbnailUrl / releaseThumbnailUrl', () => {
    it('mints exactly one shared URL for concurrent acquires of the same item', async () => {
        mocks.thumbnailsTable.get.mockResolvedValue(cachedRow());

        const [a, b, c] = await Promise.all([
            acquireThumbnailUrl('abc', 1024, RAW_URL),
            acquireThumbnailUrl('abc', 1024, RAW_URL),
            acquireThumbnailUrl('abc', 1024, RAW_URL),
        ]);

        expect(a).toMatch(/^blob:mock\//);
        expect(a).toBe(b);
        expect(b).toBe(c);
        // Exactly one object URL minted across all three acquires.
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);

        // Drain the three refs so module-level state doesn't leak into the
        // next test.
        releaseThumbnailUrl('abc');
        releaseThumbnailUrl('abc');
        releaseThumbnailUrl('abc');
    });

    it('reuses the same URL across sequential acquire/release cycles while alive', async () => {
        mocks.thumbnailsTable.get.mockResolvedValue(cachedRow());

        const first = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        // A second consumer mounts before the first releases.
        const second = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        expect(second).toBe(first);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);

        // First releases — still one consumer, URL must stay alive.
        releaseThumbnailUrl('abc');
        expect(revoked).toHaveLength(0);

        // Last consumer releases — now it revokes.
        releaseThumbnailUrl('abc');
        expect(revoked).toEqual([first]);
    });

    it('revokes only after the final release (refcount reaches zero)', async () => {
        mocks.thumbnailsTable.get.mockResolvedValue(cachedRow());

        const url = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        await acquireThumbnailUrl('abc', 1024, RAW_URL);
        await acquireThumbnailUrl('abc', 1024, RAW_URL);

        releaseThumbnailUrl('abc');
        releaseThumbnailUrl('abc');
        expect(revoked).toHaveLength(0);
        releaseThumbnailUrl('abc');
        expect(revoked).toEqual([url]);

        // After full release, a fresh acquire mints a NEW url.
        const reacquired = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        expect(reacquired).not.toBe(url);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(2);
        releaseThumbnailUrl('abc');
    });

    it('falls back to the raw URL (un-refcounted) on a cache miss', async () => {
        // No row + a 404 from the network → resolver returns the raw URL.
        mocks.thumbnailsTable.get.mockResolvedValue(undefined);
        globalThis.fetch = vi.fn(async () => ({
            headers: { get: () => null },
            ok: false,
            status: 404,
        })) as unknown as typeof fetch;

        const result = await acquireThumbnailUrl('missing', 1024, RAW_URL);
        expect(result).toBe(RAW_URL);
        expect(globalThis.URL.createObjectURL).not.toHaveBeenCalled();

        // Releasing a non-tracked item is a harmless no-op.
        expect(() => releaseThumbnailUrl('missing')).not.toThrow();
        expect(revoked).toHaveLength(0);
    });

    it('release of an unknown item is a no-op', () => {
        expect(() => releaseThumbnailUrl('never-acquired')).not.toThrow();
        expect(revoked).toHaveLength(0);
    });
});
