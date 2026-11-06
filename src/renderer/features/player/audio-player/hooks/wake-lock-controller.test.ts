import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWakeLockController, WAKE_LOCK_REFRESH_MS } from './wake-lock-controller';
import { WAKE_LOCK_RELEASE_GRACE_MS } from './wake-lock-intent';

import { PlayerStatus } from '/@/shared/types/types';

// Native watchdog in WakeLockPlugin.java; the refresh must land well inside it.
const NATIVE_WATCHDOG_MS = 10 * 60 * 1000;

describe('createWakeLockController', () => {
    let acquire: ReturnType<typeof vi.fn>;
    let release: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        acquire = vi.fn();
        release = vi.fn();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('acquires on play and keeps re-acquiring for as long as playback continues', () => {
        const controller = createWakeLockController({ acquire, release });
        controller.apply(PlayerStatus.PLAYING);
        expect(acquire).toHaveBeenCalledTimes(1);

        // An hour of uninterrupted playback across many tracks: status never
        // changes, yet the lock must be re-armed before the native watchdog
        // could ever expire it.
        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(acquire.mock.calls.length).toBeGreaterThanOrEqual(
            Math.floor((60 * 60 * 1000) / WAKE_LOCK_REFRESH_MS),
        );
        expect(release).not.toHaveBeenCalled();
        expect(WAKE_LOCK_REFRESH_MS).toBeLessThan(NATIVE_WATCHDOG_MS / 2);
    });

    it('stops refreshing and releases after the grace period on pause', () => {
        const controller = createWakeLockController({ acquire, release });
        controller.apply(PlayerStatus.PLAYING);
        controller.apply(PlayerStatus.PAUSED);
        acquire.mockClear();

        vi.advanceTimersByTime(WAKE_LOCK_RELEASE_GRACE_MS - 1);
        expect(release).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(release).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(WAKE_LOCK_REFRESH_MS * 5);
        expect(acquire).not.toHaveBeenCalled();
    });

    it('cancels a pending grace release when playback resumes', () => {
        const controller = createWakeLockController({ acquire, release });
        controller.apply(PlayerStatus.PAUSED);
        controller.apply(PlayerStatus.PLAYING);
        vi.advanceTimersByTime(WAKE_LOCK_RELEASE_GRACE_MS * 2);
        expect(release).not.toHaveBeenCalled();
    });

    it('releases immediately on stop and on dispose, with no timers left behind', () => {
        const controller = createWakeLockController({ acquire, release });
        controller.apply(PlayerStatus.PLAYING);
        controller.apply(PlayerStatus.STOPPED);
        expect(release).toHaveBeenCalledTimes(1);

        controller.apply(PlayerStatus.PLAYING);
        controller.dispose();
        expect(release).toHaveBeenCalledTimes(2);
        acquire.mockClear();
        vi.advanceTimersByTime(WAKE_LOCK_REFRESH_MS * 5);
        expect(acquire).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledTimes(2);
    });
});
