import { PlayerStatus } from '/@/shared/types/types';

/**
 * Pure player-status → native-wake-lock intent mapping.
 *
 * The native partial wake lock (cat.kenny.feishin.WakeLockPlugin) keeps the
 * CPU running with the screen off so the WebView's HTML5 <audio> element does
 * not stall when the app is backgrounded during playback — the gap the
 * media-session foreground service alone does not close on aggressive OEM
 * builds (MIUI / HyperOS on the Mi 9T).
 *
 * This module holds the decision of *what to do* with the lock for a given
 * player status, kept pure and free of any Capacitor / timer / native imports
 * so it is unit-testable in isolation. The hook that owns the side effects
 * (use-capacitor-media-session.tsx) interprets these intents:
 *
 *   - 'acquire'          -> ensure the lock is held now (play).
 *   - 'release'          -> release the lock now (no track / hard stop).
 *   - 'release-grace'    -> release the lock after a short grace period
 *                           (pause) so a quick pause→play toggle, or a brief
 *                           gap between tracks, does not thrash acquire/release
 *                           and risk a sub-second CPU suspend that stalls audio.
 */
export type WakeLockIntent = 'acquire' | 'release' | 'release-grace';

/**
 * Grace period (ms) before a paused player releases the CPU wake lock. Long
 * enough to swallow a pause→play toggle or a track-boundary gap; short enough
 * that a genuine pause stops holding the CPU awake almost immediately.
 */
export const WAKE_LOCK_RELEASE_GRACE_MS = 30_000;

/**
 * Map a player status to the wake-lock action that should be taken.
 *
 * PLAYING keeps the CPU awake. PAUSED schedules a delayed release (the player
 * is still "armed" and the user may resume). Anything else (stopped / no
 * track) releases immediately.
 */
export const wakeLockIntentForStatus = (status: PlayerStatus): WakeLockIntent => {
    switch (status) {
        case PlayerStatus.PAUSED:
            return 'release-grace';
        case PlayerStatus.PLAYING:
            return 'acquire';
        default:
            return 'release';
    }
};
