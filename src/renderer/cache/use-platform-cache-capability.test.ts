/**
 * The Library sync settings page must distinguish "the cache is DISABLED"
 * from "this PLATFORM cannot host the cache". The cache store's
 * `cacheAvailable` is forced false while the subsystem is disabled (it's a
 * kill switch, not a capability answer), which locked desktop users out:
 * the page showed "Cache unavailable on this platform" with no enable
 * toggle (Windows portable, 2026-06-10). This hook answers the platform
 * question only.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    isCacheAvailable: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('/@/renderer/cache/capability', () => ({
    isCacheAvailable: mocks.isCacheAvailable,
}));

import { usePlatformCacheCapability } from '/@/renderer/cache/use-platform-cache-capability';

describe('usePlatformCacheCapability', () => {
    beforeEach(() => {
        mocks.isCacheAvailable.mockReset();
    });

    it('reports true when the platform probe passes', async () => {
        mocks.isCacheAvailable.mockResolvedValue(true);
        const { result } = renderHook(() => usePlatformCacheCapability());
        expect(result.current).toBeNull(); // unknown while probing
        await waitFor(() => expect(result.current).toBe(true));
    });

    it('reports false when IndexedDB is genuinely unavailable', async () => {
        mocks.isCacheAvailable.mockResolvedValue(false);
        const { result } = renderHook(() => usePlatformCacheCapability());
        await waitFor(() => expect(result.current).toBe(false));
    });

    it('treats a probe error as unavailable', async () => {
        mocks.isCacheAvailable.mockRejectedValue(new Error('idb exploded'));
        const { result } = renderHook(() => usePlatformCacheCapability());
        await waitFor(() => expect(result.current).toBe(false));
    });
});
