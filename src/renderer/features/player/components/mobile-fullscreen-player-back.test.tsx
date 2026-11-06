import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBottomSheetStore } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet-store';
import { MobileFullscreenPlayer } from '/@/renderer/features/player/components/mobile-fullscreen-player';
import { useFullScreenPlayerStore } from '/@/renderer/store';

/**
 * Android back on the mobile fullscreen player: the player registers on the
 * shared back-dismiss stack so the gesture first leaves the queue / lyrics
 * view, then slides the player down (instead of the handler's store fallback
 * unmounting it with no exit animation).
 */

// The face's children are irrelevant here and pull in heavy graphs.
const { Stub } = vi.hoisted(() => ({ Stub: () => null }));
vi.mock('/@/renderer/features/now-playing/components/play-queue', () => ({ PlayQueue: Stub }));
vi.mock('/@/renderer/features/lyrics/lyrics', () => ({ Lyrics: Stub }));
vi.mock('/@/renderer/features/lyrics/api/lyrics-api', () => ({ useHasLyrics: () => false }));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-album-art', () => ({
    MobileFullscreenPlayerAlbumArt: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-header', () => ({
    MobileFullscreenPlayerHeader: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-metadata', () => ({
    MobileFullscreenPlayerMetadata: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-progress', () => ({
    MobileFullscreenPlayerProgress: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-volume', () => ({
    MobileFullscreenPlayerVolume: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-controls', () => ({
    MobileFullscreenPlayerControls: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-player-bottom-controls', () => ({
    MobileFullscreenPlayerBottomControls: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-album-card', () => ({
    MobileFullscreenAlbumCard: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-artist-card', () => ({
    MobileFullscreenArtistCard: Stub,
}));
vi.mock('/@/renderer/features/player/components/mobile-fullscreen-visualizer-card', () => ({
    MobileFullscreenVisualizerCard: Stub,
}));
vi.mock('/@/renderer/hooks', async (importOriginal) => ({
    ...((await importOriginal()) as Record<string, unknown>),
    useFastAverageColor: () => ({ background: undefined }),
}));

const renderPlayer = () =>
    render(
        <QueryClientProvider client={new QueryClient()}>
            <MantineProvider>
                <MemoryRouter>
                    <MobileFullscreenPlayer />
                </MemoryRouter>
            </MantineProvider>
        </QueryClientProvider>,
    );

const pressBack = () => {
    let consumed = false;
    act(() => {
        consumed = useBottomSheetStore.getState().dismissTop();
    });
    return consumed;
};

beforeEach(() => {
    useFullScreenPlayerStore.getState().actions.setStore({ activeTab: 'player', expanded: true });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('MobileFullscreenPlayer Android back', () => {
    it('registers on the back-dismiss stack while mounted', () => {
        const { unmount } = renderPlayer();
        expect(useBottomSheetStore.getState().dismissStack.map((e) => e.id)).toContain(
            'mobile-fullscreen-player',
        );
        unmount();
        expect(useBottomSheetStore.getState().dismissStack).toHaveLength(0);
    });

    it.each(['queue', 'lyrics'])('returns from the %s view to the player face', (tab) => {
        renderPlayer();
        act(() => useFullScreenPlayerStore.getState().actions.setStore({ activeTab: tab }));

        expect(pressBack()).toBe(true);

        expect(useFullScreenPlayerStore.getState().activeTab).toBe('player');
        expect(useFullScreenPlayerStore.getState().expanded).toBe(true);
    });

    it('slides the player down and collapses it from the player face', async () => {
        renderPlayer();

        expect(pressBack()).toBe(true);
        // The collapse runs after the slide-down animation, not instantly.
        expect(useFullScreenPlayerStore.getState().expanded).toBe(true);

        await vi.waitFor(() => expect(useFullScreenPlayerStore.getState().expanded).toBe(false), {
            timeout: 2000,
        });
    });
});
