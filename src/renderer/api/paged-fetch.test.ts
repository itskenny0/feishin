import { beforeEach, describe, expect, it, vi } from 'vitest';

import { collectAdaptivePaged, setPagedFetchRetryBaseMsForTests } from './paged-fetch';

beforeEach(() => setPagedFetchRetryBaseMsForTests(0));

const nums = (start: number, count: number): number[] =>
    Array.from({ length: Math.max(0, count) }, (_, i) => start + i);

describe('collectAdaptivePaged', () => {
    it('pages through full pages until a short page', async () => {
        // 1200 items @ 500/page → 500, 500, 200.
        const fetchPage = vi.fn(async (startIndex: number, limit: number) =>
            nums(startIndex, Math.min(limit, 1200 - startIndex)),
        );
        const out = await collectAdaptivePaged<number>(fetchPage);
        expect(out).toHaveLength(1200);
        expect(fetchPage).toHaveBeenCalledTimes(3);
        expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 500, 1000]);
    });

    it('shrinks the page size and retries the SAME offset when a page fails', async () => {
        const fetchPage = vi.fn(async (startIndex: number, limit: number) => {
            if (limit === 500) throw new Error('timeout'); // oversized page fails on a slow server
            return nums(startIndex, Math.min(limit, 3));
        });
        const out = await collectAdaptivePaged<number>(fetchPage);
        expect(out).toEqual([0, 1, 2]);
        expect(fetchPage.mock.calls.slice(0, 2)).toEqual([
            [0, 500],
            [0, 100],
        ]);
    });

    it('stops after one page when a backend ignores limit (returns more than requested)', async () => {
        // Subsonic-style: the whole list comes back regardless of limit. Must NOT
        // loop re-fetching it forever.
        const fetchPage = vi.fn(async () => nums(0, 800));
        const out = await collectAdaptivePaged<number>(fetchPage);
        expect(out).toHaveLength(800);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });

    it('throws a first-page failure at the floor (nothing was fetched)', async () => {
        const fetchPage = vi.fn(async () => {
            throw new Error('down');
        });
        await expect(collectAdaptivePaged<number>(fetchPage)).rejects.toThrow('down');
    });

    it('never retries an abort', async () => {
        const controller = new AbortController();
        const fetchPage = vi.fn(async () => {
            controller.abort();
            throw new DOMException('aborted', 'AbortError');
        });
        const out = await collectAdaptivePaged<number>(fetchPage, { signal: controller.signal });
        expect(out).toEqual([]);
        expect(fetchPage).toHaveBeenCalledTimes(1);
    });
});
