import { MantineProvider } from '@mantine/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { MobilePlayerbar } from '/@/renderer/features/player/components/mobile-playerbar';
import { useFullScreenPlayerStore } from '/@/renderer/store';

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
const setRemoteMirroredSong = (fields: {
    albumId?: string;
    hasOwnCover?: boolean;
    imageId?: null | string;
}) => {
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

    it("keys the cover on the track's own image when its art is distinct from the album", () => {
        setRemoteMirroredSong({ albumId: 'album-1', hasOwnCover: true, imageId: 'song-1' });

        renderBar();

        expect(screen.getByTestId('mini-cover').getAttribute('data-id')).toBe('song-1');
    });
});

describe('MobilePlayerbar title tap', () => {
    it('opens the fullscreen player without navigating the page underneath it', () => {
        setRemoteMirroredSong({ albumId: 'album-1' });
        useFullScreenPlayerStore.getState().actions.setStore({ expanded: false });
        let pathname = '';
        const LocationProbe = () => {
            pathname = useLocation().pathname;
            return null;
        };

        render(
            <QueryClientProvider client={new QueryClient()}>
                <MantineProvider>
                    <MemoryRouter initialEntries={['/library/albums/album-1']}>
                        <MobilePlayerbar />
                        <LocationProbe />
                    </MemoryRouter>
                </MantineProvider>
            </QueryClientProvider>,
        );

        fireEvent.click(screen.getByText('Song'));

        expect(useFullScreenPlayerStore.getState().expanded).toBe(true);
        // Closing the player must land back on the album, not the queue page.
        expect(pathname).toBe('/library/albums/album-1');
    });
});

describe('MobilePlayerbar swipe up', () => {
    // Pointer samples on the bar root, where the swipe-up listener lives.
    const swipe = (points: Array<[number, number]>) => {
        const bar = document.querySelector('.media-player') as HTMLElement;
        const [start, ...moves] = points;
        fireEvent.pointerDown(bar, { clientX: start[0], clientY: start[1], pointerType: 'touch' });
        for (const [x, y] of moves) {
            fireEvent.pointerMove(bar, { clientX: x, clientY: y, pointerType: 'touch' });
        }
        fireEvent.pointerUp(bar, { pointerType: 'touch' });
    };

    it('opens the fullscreen player even when the first move is sideways jitter', () => {
        setRemoteMirroredSong({ albumId: 'album-1' });
        useFullScreenPlayerStore.getState().actions.setStore({ expanded: false });
        renderBar();

        // A real finger's first sample is often a pixel or two sideways.
        swipe([
            [100, 400],
            [102, 399],
            [103, 370],
            [103, 330],
        ]);

        expect(useFullScreenPlayerStore.getState().expanded).toBe(true);
    });

    it('ignores a horizontal swipe (that is the prev/next carousel)', () => {
        setRemoteMirroredSong({ albumId: 'album-1' });
        useFullScreenPlayerStore.getState().actions.setStore({ expanded: false });
        renderBar();

        swipe([
            [100, 400],
            [130, 396],
            [180, 380],
            [240, 340],
        ]);

        expect(useFullScreenPlayerStore.getState().expanded).toBe(false);
    });
});
