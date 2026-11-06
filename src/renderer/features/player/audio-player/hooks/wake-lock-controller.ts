import { WAKE_LOCK_RELEASE_GRACE_MS, wakeLockIntentForStatus } from './wake-lock-intent';

import { PlayerStatus } from '/@/shared/types/types';

/**
 * How often the renderer re-acquires the native wake lock while playing. The
 * native side re-arms its 10 minute watchdog on every acquire, so this only has
 * to land well inside that window. Player status does not change across track
 * boundaries, so without a periodic refresh the lock lapsed 10 minutes into
 * continuous playback and screen-off audio could stall again.
 */
export const WAKE_LOCK_REFRESH_MS = 60_000;

export interface WakeLockController {
    /** Apply the wake-lock intent for a player status (acquire / grace / release). */
    apply: (status: PlayerStatus) => void;
    /** Cancel every timer and release now (unmount / hot reload). */
    dispose: () => void;
    /** Release now, cancelling any pending grace release (no current track). */
    releaseNow: () => void;
}

/**
 * Owns the timers around the native partial wake lock: a periodic re-acquire
 * while playing and a delayed release while paused. The pure status-to-intent
 * mapping lives in wake-lock-intent.ts; the native calls are injected.
 */
export const createWakeLockController = (lock: {
    acquire: () => void;
    release: () => void;
}): WakeLockController => {
    let releaseTimer: null | ReturnType<typeof setTimeout> = null;
    let refreshTimer: null | ReturnType<typeof setInterval> = null;

    const clearTimers = () => {
        if (releaseTimer) {
            clearTimeout(releaseTimer);
            releaseTimer = null;
        }
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    };

    const releaseNow = () => {
        clearTimers();
        lock.release();
    };

    return {
        apply: (status) => {
            const intent = wakeLockIntentForStatus(status);
            if (intent === 'acquire') {
                clearTimers();
                lock.acquire();
                refreshTimer = setInterval(lock.acquire, WAKE_LOCK_REFRESH_MS);
            } else if (intent === 'release') {
                releaseNow();
            } else {
                // Paused: hold the lock briefly so a quick resume or a
                // track-boundary gap doesn't thrash acquire/release.
                clearTimers();
                releaseTimer = setTimeout(() => {
                    releaseTimer = null;
                    lock.release();
                }, WAKE_LOCK_RELEASE_GRACE_MS);
            }
        },
        dispose: releaseNow,
        releaseNow,
    };
};
