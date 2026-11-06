import { describe, expect, it } from 'vitest';

import {
    type ExternalPlaybackCheck,
    isExternalPause,
    isExternalPlay,
    type MediaElementSnapshot,
} from './external-playback';

import { PlayerStatus } from '/@/shared/types/types';

const el = (over: Partial<MediaElementSnapshot> = {}): MediaElementSnapshot => ({
    ended: false,
    error: null,
    paused: true,
    ...over,
});

const pauseCheck = (over: Partial<ExternalPlaybackCheck> = {}): ExternalPlaybackCheck => ({
    activeSlot: 1,
    element: el({ paused: true }),
    isTransitioning: false,
    renderedStatus: PlayerStatus.PLAYING,
    slot: 1,
    storeStatus: PlayerStatus.PLAYING,
    ...over,
});

const playCheck = (over: Partial<ExternalPlaybackCheck & { hasSource: boolean }> = {}) => ({
    activeSlot: 1,
    element: el({ paused: false }),
    hasSource: true,
    isTransitioning: false,
    renderedStatus: PlayerStatus.PAUSED,
    slot: 1,
    storeStatus: PlayerStatus.PAUSED,
    ...over,
});

describe('isExternalPause', () => {
    it('flags the audible element being paused by the system mid-playback (audio focus loss)', () => {
        expect(isExternalPause(pauseCheck())).toBe(true);
    });

    it('ignores the pause the spec fires right before ended', () => {
        expect(isExternalPause(pauseCheck({ element: el({ ended: true }) }))).toBe(false);
    });

    it('ignores a pause the engine already undid (reload + play in the same task)', () => {
        expect(isExternalPause(pauseCheck({ element: el({ paused: false }) }))).toBe(false);
    });

    it('ignores pauses of the inactive (preloading / crossfading-out) slot', () => {
        expect(isExternalPause(pauseCheck({ slot: 2 }))).toBe(false);
    });

    it('ignores pauses during a gapless / crossfade hand-off', () => {
        expect(isExternalPause(pauseCheck({ isTransitioning: true }))).toBe(false);
    });

    it('ignores errored elements (the engine error path owns those)', () => {
        expect(isExternalPause(pauseCheck({ element: el({ error: { code: 2 } }) }))).toBe(false);
    });

    it('ignores pauses the player asked for (store or rendered status not playing)', () => {
        expect(isExternalPause(pauseCheck({ storeStatus: PlayerStatus.PAUSED }))).toBe(false);
        // Store already flipped back to PLAYING but the engine has not
        // re-rendered yet: this pause is our own stale one, not the system's.
        expect(isExternalPause(pauseCheck({ renderedStatus: PlayerStatus.PAUSED }))).toBe(false);
    });

    it('ignores a missing element', () => {
        expect(isExternalPause(pauseCheck({ element: null }))).toBe(false);
    });
});

describe('isExternalPlay', () => {
    it('flags the system resuming the audible element after a transient loss (call ended)', () => {
        expect(isExternalPlay(playCheck())).toBe(true);
    });

    it('ignores our own play (rendered status already PLAYING)', () => {
        expect(isExternalPlay(playCheck({ renderedStatus: PlayerStatus.PLAYING }))).toBe(false);
        expect(isExternalPlay(playCheck({ storeStatus: PlayerStatus.PLAYING }))).toBe(false);
    });

    it('ignores a play that was already paused again', () => {
        expect(isExternalPlay(playCheck({ element: el({ paused: true }) }))).toBe(false);
    });

    it('does not resurrect a stopped player or an element with no real source', () => {
        expect(isExternalPlay(playCheck({ storeStatus: PlayerStatus.STOPPED }))).toBe(false);
        expect(isExternalPlay(playCheck({ hasSource: false }))).toBe(false);
    });

    it('ignores the inactive slot (gapless / crossfade pre-start)', () => {
        expect(isExternalPlay(playCheck({ slot: 2 }))).toBe(false);
        expect(isExternalPlay(playCheck({ isTransitioning: true }))).toBe(false);
    });
});
