// Regression coverage for the sleep-timer fade-out lifecycle.
//
// When a timer expires it calls cancelTimer() (which flips the store `active`
// flag to false and unmounts the SleepTimerHook owner) and then starts a
// volume fade-out that pauses + restores volume in its final tick. The fade
// MUST run to completion even though its owning component unmounts the same
// tick — otherwise playback never actually pauses (the whole point of the
// timer) and the volume is left lowered. A previous revision cleared the fade
// interval on unmount, which aborted the fade before it ever paused; this test
// pins the corrected behavior.
//
// We mock the hook's dependencies so we can render the real SleepTimerHookInner,
// drive the end-of-song event, unmount, and assert mediaPause fired after the
// fade window elapsed.

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mock surface -----------------------------------------------------

const mocks = vi.hoisted(() => ({
    cancelTimer: vi.fn(),
    fadeSeconds: { current: 2 },
    mediaPause: vi.fn(),
    mode: { current: 'endOfSong' as 'endOfAlbum' | 'endOfSong' | 'timed' },
    // Captured player-event callbacks so the test can fire them.
    onCurrentSongChange: { current: undefined as (() => void) | undefined },
    onPlayerProgress: {
        current: undefined as
            | ((p: { timestamp: number }, prev: { timestamp: number }) => void)
            | undefined,
    },
    setRemaining: vi.fn(),
    setTargetAlbumId: vi.fn(),
    setVolume: vi.fn(),
    volume: { current: 80 },
}));

vi.mock('/@/renderer/features/player/audio-player/hooks/use-player-events', () => ({
    usePlayerEvents: (callbacks: {
        onCurrentSongChange?: () => void;
        onPlayerProgress?: (p: { timestamp: number }, prev: { timestamp: number }) => void;
    }) => {
        mocks.onCurrentSongChange.current = callbacks.onCurrentSongChange;
        mocks.onPlayerProgress.current = callbacks.onPlayerProgress;
    },
}));

vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ mediaPause: mocks.mediaPause }),
}));

vi.mock('/@/renderer/store/player.store', () => ({
    usePlayerActions: () => ({ setVolume: mocks.setVolume }),
    usePlayerShuffle: () => 'none',
    usePlayerStatus: () => 'playing',
    usePlayerStoreBase: {
        getState: () => ({
            getPlayerData: () => ({ currentSong: undefined, nextSong: undefined }),
            player: { volume: mocks.volume.current },
            setPauseOnNextSongEnd: vi.fn(),
        }),
    },
}));

vi.mock('/@/renderer/store/settings.store', () => ({
    useSettingsStoreActions: () => ({ setSettings: vi.fn() }),
    useSleepTimerFadeSeconds: () => mocks.fadeSeconds.current,
}));

vi.mock('/@/renderer/store/sleep-timer.store', () => ({
    useSleepTimerActions: () => ({
        cancelTimer: mocks.cancelTimer,
        setRemaining: mocks.setRemaining,
        setTargetAlbumId: mocks.setTargetAlbumId,
    }),
    useSleepTimerActive: () => true,
    useSleepTimerMode: () => mocks.mode.current,
    useSleepTimerStore: {
        getState: () => ({ remaining: 0, targetAlbumId: null }),
    },
}));

import { SleepTimerHookInner } from '/@/renderer/features/player/components/sleep-timer-button';

beforeEach(() => {
    vi.useFakeTimers();
    mocks.cancelTimer.mockClear();
    mocks.mediaPause.mockClear();
    mocks.setVolume.mockClear();
    mocks.fadeSeconds.current = 2;
    mocks.volume.current = 80;
    mocks.mode.current = 'endOfSong';
    mocks.onCurrentSongChange.current = undefined;
    mocks.onPlayerProgress.current = undefined;
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('sleep timer fade-out lifecycle', () => {
    it('completes the fade and pauses even after the owner unmounts (end-of-song)', () => {
        const view = render(<SleepTimerHookInner />);
        expect(mocks.onCurrentSongChange.current).toBeDefined();

        // Timer expiry path: song change in end-of-song mode cancels + fades.
        mocks.onCurrentSongChange.current!();

        // The fade has NOT paused yet (it pauses in its final tick).
        expect(mocks.mediaPause).not.toHaveBeenCalled();

        // Simulate cancelTimer() flipping `active` false → owner unmounts.
        view.unmount();

        // Advance past the full 2s fade window.
        vi.advanceTimersByTime(2100);

        // The fade survived unmount and paused playback exactly once.
        expect(mocks.mediaPause).toHaveBeenCalledTimes(1);

        // And the volume is restored after the post-pause settle timeout.
        vi.advanceTimersByTime(200);
        const lastVolume = mocks.setVolume.mock.calls.at(-1)?.[0];
        expect(lastVolume).toBe(80);
    });

    it("does not fire a prior fade's trailing volume-restore once a new fade supersedes it", () => {
        const view = render(<SleepTimerHookInner />);

        // First fade: expire, then run it to completion so it pauses and
        // SCHEDULES the trailing volume-restore (but don't let that timeout
        // fire yet — it's queued at tickMs=100ms after the final tick).
        mocks.onCurrentSongChange.current!();
        vi.advanceTimersByTime(2000); // full 2s fade → pause + schedule restore
        expect(mocks.mediaPause).toHaveBeenCalledTimes(1);

        // Before the trailing restore (100ms) lands, a second fade starts.
        // It must cancel the first fade's pending restore so the queued
        // setVolume(80) never fires after this new fade has taken over.
        mocks.setVolume.mockClear();
        mocks.onCurrentSongChange.current!();

        // Advance past where the FIRST restore would have fired.
        vi.advanceTimersByTime(150);

        // The stale restore (a jump straight back to 80) must not appear; the
        // new fade is ramping down from 80, so any setVolume here is a fade
        // step strictly below the starting volume.
        for (const call of mocks.setVolume.mock.calls) {
            expect(call[0]).toBeLessThan(80);
        }

        view.unmount();
    });

    it('pauses immediately (no fade) when fade is disabled', () => {
        mocks.fadeSeconds.current = 0;
        const view = render(<SleepTimerHookInner />);

        mocks.onCurrentSongChange.current!();
        // Hard pause fires synchronously with fade disabled.
        expect(mocks.mediaPause).toHaveBeenCalledTimes(1);

        view.unmount();
        vi.advanceTimersByTime(2100);
        // No stray extra pause from a phantom interval.
        expect(mocks.mediaPause).toHaveBeenCalledTimes(1);
    });
});
