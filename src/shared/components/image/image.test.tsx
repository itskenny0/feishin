import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const nativeImage = vi.hoisted(() => ({
    calls: [] as { enabled: boolean; request?: { cacheKey: string } }[],
    state: { displaySrc: undefined as string | undefined, isLoaded: false },
}));

vi.mock('/@/shared/components/image/use-native-image', () => ({
    hasSharedThumbnailUrl: () => false,
    useNativeImage: (args: { enabled: boolean; request?: { cacheKey: string } }) => {
        nativeImage.calls.push(args);
        return { ...nativeImage.state, isError: false, isLoading: false, isNotCached: false };
    },
}));

vi.mock('/@/shared/hooks/use-in-viewport', () => ({
    useInViewport: () => ({ inViewport: false, ref: undefined }),
}));

import { BaseImage } from '/@/shared/components/image/image';

describe('BaseImage', () => {
    it("does not mark a new cover as loaded from the previous cover's loaded state", () => {
        nativeImage.state = { displaySrc: 'blob:cover-a', isLoaded: true };
        const { rerender } = render(<BaseImage src="image-test-cover-a" />);

        // Switch src while the native image still reports the previous
        // cover's loaded state (it resets in its own effect).
        nativeImage.calls = [];
        rerender(<BaseImage src="image-test-cover-b" />);

        // Off-screen and never actually loaded: cover B must not be enabled
        // as if it were already in the session cache.
        const lastCall = nativeImage.calls[nativeImage.calls.length - 1];
        expect(lastCall.request?.cacheKey).toBe('image-test-cover-b');
        expect(lastCall.enabled).toBe(false);
    });
});
