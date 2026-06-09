// Regression test: covers already held in the shared URL memory cache must
// render WITHOUT entering the loading (skeleton) state — a synchronous peek
// adopts the live blob: URL before any async resolve is started.

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    registerThumbnailUrlCache,
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

        // The peeked reference is owned by the hook — unmount releases it.
        await act(async () => {
            unmount();
        });
        expect(release).toHaveBeenCalledWith('abc', 'itemCard');
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
