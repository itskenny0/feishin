import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { MobilePlayerbar } from '/@/renderer/features/player/components/mobile-playerbar';

// Probe the ItemImage so we can assert which entity id the mini-player cover
// keys on. Preserve the module's other exports (e.g. useCachedItemImageUrl)
// that the surrounding tree relies on.
vi.mock('/@/renderer/components/item-image/item-image', async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        ItemImage: (props: { id?: null | string }) => (
            <div data-id={props.id ?? ''} data-testid="mini-cover" />
        ),
    };
});

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

// Drive `currentSong` (via the remote mirror) with an explicit albumId/imageId
// so we can assert the cover's cache key. `useActiveNowPlayingItem` returns the
// mirrored now-playing item unchanged when a Connect target is active.
const setRemoteMirroredSong = (fields: { albumId?: string; imageId?: null | string }) => {
    const { actions } = useRemoteTargetStore.getState();
    actions.setTarget({
        capabilities: ['PlayPause', 'NextTrack', 'PreviousTrack'],
        deviceId: 'dev-1',
        deviceName: 'Living Room',
        sessionId: 'sess-1',
    });
    actions.setMirrored({
        nowPlayingItem: {
            album: 'Album',
            artists: [],
            duration: 200_000,
            id: 'song-1',
            name: 'Song',
            ...fields,
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
};

describe('MobilePlayerbar cover cache key', () => {
    it('keys the cover on albumId (not the song imageId) so it hits the album-keyed thumbnail cache', () => {
        // Subsonic/Navidrome: imageId is the media-file coverArt id, which the
        // thumbnail sweep never caches (it keys covers by albumId).
        setRemoteMirroredSong({ albumId: 'album-1', imageId: 'coverart-9' });

        renderBar();

        expect(screen.getByTestId('mini-cover').getAttribute('data-id')).toBe('album-1');
    });

    it('falls back to the song imageId when no albumId is present', () => {
        setRemoteMirroredSong({ albumId: undefined, imageId: 'coverart-9' });

        renderBar();

        expect(screen.getByTestId('mini-cover').getAttribute('data-id')).toBe('coverart-9');
    });
});
