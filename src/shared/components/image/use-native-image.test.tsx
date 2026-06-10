// Regression test: covers already held in the shared URL memory cache must
// render WITHOUT entering the loading (skeleton) state — a synchronous peek
// adopts the live blob: URL before any async resolve is started.

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    registerThumbnailDegradedProbe,
    registerThumbnailUrlCache,
    THUMBNAIL_UPGRADED_EVENT,
    useNativeImage,
} from '/@/shared/components/image/use-native-image';

const request = {
    cacheItemId: 'abc',
    cacheKey: 'k',
    cacheSize: 300,
    url: 'https://server.example/Items/abc/Images/Primary?width=300',
    variant: 'itemCard',
};

afterEach(() => {
    registerThumbnailUrlCache(null, null, null);
    registerThumbnailDegradedProbe(null);
    vi.clearAllMocks();
});

describe('useNativeImage — synchronous peek fast path', () => {
    it('adopts a memory-cached shared URL without a loading state or async resolve', async () => {
        const acquire = vi.fn(() => new Promise<string>(() => {})); // never resolves
        const release = vi.fn();
        const peek = vi.fn(() => 'blob:shared/abc-itemCard');
        registerThumbnailUrlCache(acquire, release, peek);

        const { result, unmount } = renderHook(() => useNativeImage({ enabled: true, request }));

        // The peek is synchronous: after mount effects the image is LOADED
        // with the shared URL; the async acquire path was never entered.
        expect(result.current.displaySrc).toBe('blob:shared/abc-itemCard');
        expect(result.current.isLoaded).toBe(true);
        expect(result.current.isLoading).toBe(false);
        expect(peek).toHaveBeenCalledWith('abc', 'itemCard');
        expect(acquire).not.toHaveBeenCalled();

        // The peeked reference is owned by the hook — unmount releases it
        // (carrying the held URL so a displaced/orphaned entry settles
        // against the right blob).
        await act(async () => {
            unmount();
        });
        expect(release).toHaveBeenCalledWith('abc', 'itemCard', 'blob:shared/abc-itemCard');
    });

    it('falls through to the async acquire when nothing is held in memory', async () => {
        const acquire = vi.fn(async () => 'blob:resolved/abc-itemCard');
        const release = vi.fn();
        const peek = vi.fn(() => undefined);
        registerThumbnailUrlCache(acquire, release, peek);

        const { result } = renderHook(() => useNativeImage({ enabled: true, request }));

        await act(async () => {
            await Promise.resolve();
        });

        expect(peek).toHaveBeenCalled();
        expect(acquire).toHaveBeenCalled();
        expect(result.current.displaySrc).toBe('blob:resolved/abc-itemCard');
    });
});

describe('useNativeImage — degraded-cover upgrade', () => {
    it('re-resolves when the exact bucket lands for a DEGRADED adoption', async () => {
        // Adoption was degraded (the cache layer served a stale/undersized
        // substitute); the exact-bucket write later fires the upgrade event
        // and the hook must adopt the fresh blob.
        let degraded = true;
        let acquireResult = 'blob:degraded/abc-itemCard';
        const acquire = vi.fn(async () => acquireResult);
        const release = vi.fn();
        const peek = vi.fn(() => undefined);
        registerThumbnailUrlCache(acquire, release, peek);
        registerThumbnailDegradedProbe(() => degraded);

        const { result } = renderHook(() => useNativeImage({ enabled: true, request }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(result.current.displaySrc).toBe('blob:degraded/abc-itemCard');

        // The exact bucket lands: the cache layer cleared the degraded flag,
        // invalidated the shared entry, and announced the upgrade.
        degraded = false;
        acquireResult = 'blob:fresh/abc-itemCard';
        await act(async () => {
            window.dispatchEvent(
                new CustomEvent(THUMBNAIL_UPGRADED_EVENT, {
                    detail: { itemId: 'abc', variant: 'itemCard' },
                }),
            );
            await Promise.resolve();
        });

        expect(result.current.displaySrc).toBe('blob:fresh/abc-itemCard');
        // The degraded reference was settled (release carried ITS url).
        expect(release).toHaveBeenCalledWith('abc', 'itemCard', 'blob:degraded/abc-itemCard');
    });

    it('ignores upgrade events for other items and for non-degraded adoptions', async () => {
        const acquire = vi.fn(async () => 'blob:resolved/abc-itemCard');
        const release = vi.fn();
        registerThumbnailUrlCache(acquire, release, () => undefined);
        registerThumbnailDegradedProbe(() => false); // adoption was NOT degraded

        const { result } = renderHook(() => useNativeImage({ enabled: true, request }));
        await act(async () => {
            await Promise.resolve();
        });
        expect(acquire).toHaveBeenCalledTimes(1);

        await act(async () => {
            window.dispatchEvent(
                new CustomEvent(THUMBNAIL_UPGRADED_EVENT, {
                    detail: { itemId: 'abc', variant: 'itemCard' },
                }),
            );
            window.dispatchEvent(
                new CustomEvent(THUMBNAIL_UPGRADED_EVENT, {
                    detail: { itemId: 'other', variant: 'itemCard' },
                }),
            );
            await Promise.resolve();
        });

        // No re-resolve: still exactly one acquire, same URL displayed.
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(result.current.displaySrc).toBe('blob:resolved/abc-itemCard');
    });
});
