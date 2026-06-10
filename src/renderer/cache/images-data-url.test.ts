// getCachedThumbnailDataUrl: cache-only artwork for NATIVE consumers (the
// Android media-notification plugin can't read blob:/object URLs and
// natively fetching a remote URL offline crashes the app). Verifies the
// variant pick (largest under the transfer cap, smallest as oversized
// fallback) and the no-cache miss.

import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rows: [] as unknown[],
}));

vi.mock('/@/renderer/cache/db', () => ({
    awaitActiveCacheDb: async () => null,
    getActiveCacheDb: () => ({
        thumbnails: {
            where: () => ({
                equals: () => ({
                    toArray: async () => mocks.rows,
                }),
            }),
        },
    }),
}));

import { getCachedThumbnailDataUrl } from '/@/renderer/cache/images';

const row = (variant: string, size: number) => ({
    Blob: new Blob(['x'.repeat(size)], { type: 'image/jpeg' }),
    ItemId: 'item-1',
    Size: size,
    Variant: variant,
});

describe('getCachedThumbnailDataUrl', () => {
    it('returns null when nothing is cached', async () => {
        mocks.rows = [];
        expect(await getCachedThumbnailDataUrl('item-1')).toBeNull();
    });

    it('returns a data: URL for the largest variant under the cap', async () => {
        mocks.rows = [row('table', 100), row('itemCard', 400), row('fullScreen', 900_000)];
        const url = await getCachedThumbnailDataUrl('item-1');
        expect(url).toMatch(/^data:image\/jpeg;base64,/);
        // itemCard (400B) is the largest under the 500KB cap — fullScreen
        // (900KB) must be skipped. base64 of 400 bytes ≈ 536 chars.
        expect(url!.length).toBeLessThan(1000);
        expect(url!.length).toBeGreaterThan(400);
    });

    it('falls back to the smallest variant when everything is oversized', async () => {
        mocks.rows = [row('fullScreen', 900_000), row('itemCard', 600_000)];
        const url = await getCachedThumbnailDataUrl('item-1');
        expect(url).toMatch(/^data:image\/jpeg;base64,/);
        // smallest = itemCard (600KB) → base64 ≈ 800K chars.
        expect(url!.length).toBeGreaterThan(700_000);
    });

    it('ignores negative-cache markers (rows without a Blob)', async () => {
        mocks.rows = [{ Blob: undefined, ItemId: 'item-1', Variant: 'itemCard' }];
        expect(await getCachedThumbnailDataUrl('item-1')).toBeNull();
    });
});
