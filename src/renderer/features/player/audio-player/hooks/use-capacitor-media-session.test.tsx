// The Android lock-screen / notification seekbar extrapolates from the last
// position pushed to the native media session. Position used to be pushed only
// by a 5s ticker, so pausing made the bar jump back by up to 5s, a seek from
// the lock screen snapped back until the next tick, and a new track ran on
// with the previous track's position. These tests pin the immediate pushes.

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mediaSession, wakeLock } = vi.hoisted(() => ({
    mediaSession: {
        setActionHandler: vi.fn(() => Promise.resolve()),
        setMetadata: vi.fn(() => Promise.resolve()),
        setPlaybackState: vi.fn(() => Promise.resolve()),
        setPositionState: vi.fn((_state: unknown) => Promise.resolve()),
    },
    wakeLock: {
        acquire: vi.fn(() => Promise.resolve()),
        isHeld: vi.fn(() => Promise.resolve({ held: false })),
        release: vi.fn(() => Promise.resolve()),
    },
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
    },
    registerPlugin: () => wakeLock,
}));

vi.mock('@jofr/capacitor-media-session', () => ({ MediaSession: mediaSession }));

vi.mock('/@/renderer/cache/images', () => ({
    getCachedThumbnailDataUrl: () => Promise.resolve(null),
}));

vi.mock('/@/renderer/components/item-image/item-image', () => ({
    getItemImageUrl: () => null,
}));

import { CapacitorMediaSessionHook } from './use-capacitor-media-session';

import { useRadioStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { Song } from '/@/shared/types/domain-types';
import { PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

const song = (id: string, durationMs: number) =>
    ({
        _serverId: 'srv',
        _uniqueId: id,
        album: 'Album',
        artistName: 'Artist',
        duration: durationMs,
        id,
        itemType: 'song',
        name: id,
    }) as unknown as Song;

const seed = (status: PlayerStatus) => {
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: 0, shuffle: PlayerShuffle.NONE, speed: 1, status },
        queue: {
            ...s.queue,
            default: ['a', 'b'],
            shuffled: [],
            songs: { a: song('a', 200_000), b: song('b', 90_000) },
        },
    }));
    useTimestampStoreBase.setState({ timestamp: 42 });
};

const lastPosition = () => mediaSession.setPositionState.mock.calls.at(-1)?.[0];

const mount = async () => {
    const view = render(<CapacitorMediaSessionHook />);
    // Let init() register the handlers and prime the current state.
    await act(async () => {});
    mediaSession.setPositionState.mockClear();
    mediaSession.setPlaybackState.mockClear();
    return view;
};

describe('Android media session position state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seed(PlayerStatus.PLAYING);
    });

    afterEach(() => {
        usePlayerStoreBase.getState().clearQueue();
        useTimestampStoreBase.setState({ timestamp: 0 });
    });

    it('pushes the exact position when playback pauses', async () => {
        const view = await mount();
        useTimestampStoreBase.setState({ timestamp: 47.5 });
        act(() => usePlayerStoreBase.getState().mediaPause());

        expect(mediaSession.setPlaybackState).toHaveBeenCalledWith({ playbackState: 'paused' });
        expect(lastPosition()).toEqual({ duration: 200, playbackRate: 1, position: 47.5 });
        view.unmount();
    });

    it('pushes the new position as soon as a seek happens', async () => {
        const view = await mount();
        act(() => usePlayerStoreBase.getState().mediaSeekToTimestamp(120));

        expect(lastPosition()).toEqual({ duration: 200, playbackRate: 1, position: 120 });
        view.unmount();
    });

    it('pushes the next track duration and a reset position on track change', async () => {
        const view = await mount();
        act(() => usePlayerStoreBase.getState().mediaNext(false));

        expect(lastPosition()).toEqual({ duration: 90, playbackRate: 1, position: 0 });
        view.unmount();
    });

    it('reports the playback speed so the seekbar runs at the right rate', async () => {
        const view = await mount();
        act(() => usePlayerStoreBase.getState().setSpeed(1.5));

        expect(lastPosition()).toMatchObject({ playbackRate: 1.5 });
        view.unmount();
    });

    it('keeps re-acquiring the wake lock through long uninterrupted playback', async () => {
        vi.useFakeTimers();
        try {
            const view = await mount();
            wakeLock.acquire.mockClear();
            // 15 minutes, status never changes: the native lock's 10 minute
            // watchdog must be re-armed along the way.
            act(() => vi.advanceTimersByTime(15 * 60 * 1000));
            expect(wakeLock.acquire.mock.calls.length).toBeGreaterThanOrEqual(10);
            view.unmount();
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops pushing and releases the wake lock on unmount', async () => {
        const view = await mount();
        view.unmount();
        expect(wakeLock.release).toHaveBeenCalled();

        mediaSession.setPositionState.mockClear();
        act(() => usePlayerStoreBase.getState().mediaSeekToTimestamp(10));
        expect(mediaSession.setPositionState).not.toHaveBeenCalled();
    });
});

describe('Android media session while radio plays', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        seed(PlayerStatus.PLAYING);
    });

    afterEach(() => {
        useRadioStore.getState().actions.clear();
        usePlayerStoreBase.getState().clearQueue();
        useTimestampStoreBase.setState({ timestamp: 0 });
    });

    it('shows the station / stream title instead of the last queue song, then restores it', async () => {
        const view = await mount();
        mediaSession.setMetadata.mockClear();

        act(() => {
            useRadioStore.setState({
                currentStreamUrl: 'http://radio/stream',
                stationName: 'KEXP',
            });
        });
        expect(mediaSession.setMetadata).toHaveBeenLastCalledWith({
            album: '',
            artist: '',
            artwork: [],
            title: 'KEXP',
        });
        expect(lastPosition()).toEqual({ duration: 0, playbackRate: 1, position: 0 });

        act(() => {
            useRadioStore.setState({ metadata: { artist: 'Band', title: 'Live Song' } });
        });
        expect(mediaSession.setMetadata).toHaveBeenLastCalledWith(
            expect.objectContaining({ artist: 'Band', title: 'Live Song' }),
        );

        act(() => useRadioStore.getState().actions.clear());
        await act(async () => {});
        expect(mediaSession.setMetadata).toHaveBeenLastCalledWith(
            expect.objectContaining({ title: 'a' }),
        );
        view.unmount();
    });
});
