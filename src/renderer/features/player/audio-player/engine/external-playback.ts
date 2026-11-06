import { PlayerStatus } from '/@/shared/types/types';

/**
 * Detects play/pause changes of the web engine's <audio> elements that the
 * player did not ask for, so the store can follow them.
 *
 * The platform pauses and resumes media on its own: on Android the WebView
 * holds audio focus for the page and pauses it when focus is lost (a phone
 * call, another music app, a voice assistant), then resumes it when a
 * transient loss ends; iOS does the same around AVAudioSession interruptions.
 * Without following those changes the store kept saying "playing" while the
 * audio was silent (play/pause button, lock-screen notification, wake lock and
 * remote peers all wrong) and needed two taps to recover.
 *
 * Kept pure so the decision is unit-testable; the engine supplies the element
 * snapshot and web-player.tsx supplies the rendered and store status.
 */
export interface ExternalPlaybackCheck {
    /** Slot the player currently treats as the audible one. */
    activeSlot: number;
    element: MediaElementSnapshot | null;
    /** True while a gapless / crossfade hand-off is in flight. */
    isTransitioning: boolean;
    /** Status the engine was last rendered with (lags the store during fades). */
    renderedStatus: PlayerStatus;
    /** Slot whose element fired the event. */
    slot: number;
    /** Player store status right now. */
    storeStatus: PlayerStatus;
}

export interface MediaElementSnapshot {
    ended: boolean;
    error: unknown;
    paused: boolean;
}

const isCandidate = (
    check: ExternalPlaybackCheck,
): check is ExternalPlaybackCheck & {
    element: MediaElementSnapshot;
} =>
    check.slot === check.activeSlot &&
    !check.isTransitioning &&
    check.element !== null &&
    !check.element.ended &&
    !check.element.error;

/**
 * The audible element paused while both the rendered engine and the store
 * want it playing, and it is still paused now (not a pause immediately undone
 * by our own reload + play), not because the track ended (the spec fires
 * 'pause' right before 'ended') and not because of a media error (handled by
 * the engine's error path).
 */
export const isExternalPause = (check: ExternalPlaybackCheck): boolean =>
    isCandidate(check) &&
    check.element.paused &&
    check.renderedStatus === PlayerStatus.PLAYING &&
    check.storeStatus === PlayerStatus.PLAYING;

/**
 * The audible element started playing while the player is paused and nothing
 * on our side asked for it (every engine play path runs with the rendered
 * status already PLAYING). Only a PAUSED store is followed: a stopped player
 * has no current track to resume.
 */
export const isExternalPlay = (check: ExternalPlaybackCheck & { hasSource: boolean }): boolean =>
    isCandidate(check) &&
    check.hasSource &&
    !check.element.paused &&
    check.renderedStatus !== PlayerStatus.PLAYING &&
    check.storeStatus === PlayerStatus.PAUSED;
