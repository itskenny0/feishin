import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { MobilePlayerbar } from '/@/renderer/features/player/components/mobile-playerbar';

const renderBar = () => {
    const queryClient = new QueryClient();
    return render(
        <QueryClientProvider client={queryClient}>
            <MantineProvider>
                <MemoryRouter>
                    <MobilePlayerbar />
                </MemoryRouter>
            </MantineProvider>
        </QueryClientProvider>,
    );
};

afterEach(() => {
    cleanup();
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('MobilePlayerbar remote mirroring', () => {
    it('shows the remote device now-playing item when a Connect target is active', () => {
        const { actions } = useRemoteTargetStore.getState();
        actions.setTarget({
            capabilities: ['PlayPause', 'NextTrack', 'PreviousTrack'],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        actions.setMirrored({
            nowPlayingItem: {
                album: 'Remote Album',
                artists: [{ id: 'a1', name: 'Remote Artist' }],
                duration: 200_000,
                id: 'song-remote',
                name: 'Remote Song',
            } as never,
            playState: {
                isMuted: false,
                isPaused: true,
                positionMs: 0,
                positionSampledAt: 0,
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 100,
            },
        });

        renderBar();

        // The mini-player reflects the remote track, not the (empty) local one.
        expect(screen.queryByText('Remote Song')).not.toBeNull();
        expect(screen.queryByText('Remote Artist')).not.toBeNull();
    });
});
