// Unit tests for the shared, refcounted thumbnail object-URL cache added to
// images.ts. The goal of `acquireThumbnailUrl` / `releaseThumbnailUrl` is to
// hand every mounted consumer of the SAME item ONE shared blob: URL and to
// revoke it exactly once — after the last consumer releases it AND the
// zero-ref grace window expires (the grace window lets a scroll-back
// re-adopt the URL synchronously instead of re-paying the Dexie roundtrip).

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
    NO_ARTWORK_URL: 'feishin://no-artwork',
    registerThumbnailDegradedProbe: vi.fn(),
    registerThumbnailUrlCache: vi.fn(),
}));

import {
    __resetSharedThumbnailUrls,
    acquireThumbnailUrl,
    releaseThumbnailUrl,
} from '/@/renderer/cache/images';

const RAW_URL = 'https://server.example/Items/abc/Images/Primary';

// Long enough to clear the zero-ref grace window + sweep cadence.
const PAST_GRACE_MS = 10 * 60_000;

let urlCounter = 0;
const revoked: string[] = [];

beforeEach(() => {
    vi.useFakeTimers();
    urlCounter = 0;
    revoked.length = 0;
    mocks.thumbnailsTable.get.mockReset();
    mocks.thumbnailsTable.update.mockReset().mockResolvedValue(undefined);
    // Deterministic, unique blob: URLs so we can assert reuse vs churn.
    globalThis.URL.createObjectURL = vi.fn(() => `blob:mock/${++urlCounter}`);
    globalThis.URL.revokeObjectURL = vi.fn((u: string) => {
        revoked.push(u);
    });
    // Shared-URL state is module-level; entries now outlive their consumers
    // (grace window), so every test starts from a clean slate.
    __resetSharedThumbnailUrls();
    revoked.length = 0;
});

afterEach(() => {
    vi.useRealTimers();
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

        // Last consumer releases — the grace window keeps it alive so a
        // scroll-back can re-adopt it; only after expiry does it revoke.
        releaseThumbnailUrl('abc');
        expect(revoked).toHaveLength(0);
        vi.advanceTimersByTime(PAST_GRACE_MS);
        expect(revoked).toEqual([first]);
    });

    it('revokes only after the final release + grace expiry', async () => {
        mocks.thumbnailsTable.get.mockResolvedValue(cachedRow());

        const url = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        await acquireThumbnailUrl('abc', 1024, RAW_URL);
        await acquireThumbnailUrl('abc', 1024, RAW_URL);

        releaseThumbnailUrl('abc');
        releaseThumbnailUrl('abc');
        expect(revoked).toHaveLength(0);

        // Final release: still alive inside the grace window — a re-acquire
        // within it reuses the SAME url with no new objectURL minted.
        releaseThumbnailUrl('abc');
        expect(revoked).toHaveLength(0);
        const readopted = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        expect(readopted).toBe(url);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(1);

        // Release again and let the grace window lapse — now it revokes,
        // and a fresh acquire mints a NEW url.
        releaseThumbnailUrl('abc');
        vi.advanceTimersByTime(PAST_GRACE_MS);
        expect(revoked).toEqual([url]);
        const reacquired = await acquireThumbnailUrl('abc', 1024, RAW_URL);
        expect(reacquired).not.toBe(url);
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(2);
        releaseThumbnailUrl('abc');
    });

    it('returns the no-artwork sentinel (un-refcounted) on an authoritative 404', async () => {
        // No row + a 404 from the network → the server says this item HAS no
        // artwork, so the resolver hands back the sentinel and the consumer
        // shows its placeholder instead of re-fetching a URL known to 404.
        mocks.thumbnailsTable.get.mockResolvedValue(undefined);
        globalThis.fetch = vi.fn(async () => ({
            headers: { get: () => null },
            ok: false,
            status: 404,
        })) as unknown as typeof fetch;

        const result = await acquireThumbnailUrl('missing', 1024, RAW_URL);
        expect(result).toBe('feishin://no-artwork');
        expect(globalThis.URL.createObjectURL).not.toHaveBeenCalled();

        // Releasing a non-tracked item is a harmless no-op.
        expect(() => releaseThumbnailUrl('missing')).not.toThrow();
        expect(revoked).toHaveLength(0);
    });

    it('release of an unknown item is a no-op', () => {
        expect(() => releaseThumbnailUrl('never-acquired')).not.toThrow();
        expect(revoked).toHaveLength(0);
    });

    it('resolves each variant to its OWN blob for concurrent acquires of the same item at different variants', async () => {
        // Two distinct blobs, one per (item, variant) row. The Dexie mock
        // keys on the compound `[itemId, variant]` get argument, so each
        // variant resolves its own row — exactly the offline/cached case
        // where a grid card (itemCard) and the now-playing cover
        // (fullScreen) race for the same item.
        const cardBlob = new Blob(['card-variant-bytes']);
        const fullBlob = new Blob(['fullscreen-variant-bytes']);
        mocks.thumbnailsTable.get.mockImplementation(async (key: [string, string]) => {
            const [, variant] = key;
            const blob = variant === 'itemCard' ? cardBlob : fullBlob;
            return {
                Blob: blob,
                ItemId: 'abc',
                LastUsed: Date.now(),
                Size: 1024,
                Variant: variant,
            };
        });

        // Map each minted blob: URL back to the blob it was created from so
        // we can assert no cross-variant handoff occurred.
        const blobForUrl = new Map<string, Blob>();
        globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
            const u = `blob:mock/${++urlCounter}`;
            blobForUrl.set(u, blob);
            return u;
        });

        const [card, full] = await Promise.all([
            acquireThumbnailUrl('abc', 'itemCard', RAW_URL),
            acquireThumbnailUrl('abc', 'fullScreen', RAW_URL),
        ]);

        expect(card).toMatch(/^blob:mock\//);
        expect(full).toMatch(/^blob:mock\//);
        // Different variants → different shared URLs (no collapse).
        expect(card).not.toBe(full);
        // Two object URLs minted: one per variant.
        expect(globalThis.URL.createObjectURL).toHaveBeenCalledTimes(2);
        // Each URL is backed by its OWN variant's blob — the core bug was
        // the second caller getting the first variant's blob (or undefined).
        expect(blobForUrl.get(card)).toBe(cardBlob);
        expect(blobForUrl.get(full)).toBe(fullBlob);

        // Releasing one variant must NOT affect the other variant's URL;
        // both revoke independently once the grace window lapses.
        releaseThumbnailUrl('abc', 'itemCard');
        releaseThumbnailUrl('abc', 'fullScreen');
        expect(revoked).toHaveLength(0);
        vi.advanceTimersByTime(PAST_GRACE_MS);
        expect(revoked).toEqual(expect.arrayContaining([card, full]));
        expect(revoked).toHaveLength(2);
    });
});
