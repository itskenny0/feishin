import { describe, expect, it, vi } from 'vitest';

import {
    derivePlayState,
    mirrorSession,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

const fakeServer = {
    credential: 'tok',
    id: 'srv',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'https://example',
    userId: 'u1',
    username: 'demo',
} as unknown as ServerListItemWithCredential;

describe('derivePlayState', () => {
    it('converts PositionTicks to ms and stamps the sample time', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const ps = derivePlayState({
            PlayState: {
                IsPaused: false,
                PlaybackOrder: 'Shuffle',
                PositionTicks: 50_000_000, // 5s
                RepeatMode: 'RepeatAll',
                VolumeLevel: 42,
            },
        });
        expect(ps).toEqual({
            isMuted: false,
            isPaused: false,
            positionMs: 5_000,
            positionSampledAt: 1_000,
            repeatMode: 'RepeatAll',
            shuffle: true,
            volume: 42,
        });
        vi.restoreAllMocks();
    });

    it('falls back to defaults when PlayState is missing', () => {
        vi.spyOn(Date, 'now').mockReturnValue(7);
        const ps = derivePlayState({});
        expect(ps).toEqual({
            isMuted: false,
            isPaused: false,
            positionMs: 0,
            positionSampledAt: 7,
            repeatMode: 'RepeatNone',
            shuffle: false,
            volume: 100,
        });
        vi.restoreAllMocks();
    });

    /**
     * Regression: `IsMuted` was previously not mirrored into the play state,
     * so the controller's mute toggle UI silently disagreed with the target
     * whenever the target was mute-without-volume-zero. Verify both polarities
     * round-trip through derivePlayState.
     */
    it('mirrors IsMuted independently from VolumeLevel', () => {
        const muted = derivePlayState({
            PlayState: { IsMuted: true, VolumeLevel: 60 },
        });
        expect(muted.isMuted).toBe(true);
        expect(muted.volume).toBe(60);

        const unmuted = derivePlayState({
            PlayState: { IsMuted: false, VolumeLevel: 0 },
        });
        expect(unmuted.isMuted).toBe(false);
        expect(unmuted.volume).toBe(0);
    });

    it('treats PlaybackOrder Default (or absent) as not shuffled', () => {
        expect(derivePlayState({ PlayState: { PlaybackOrder: 'Default' } }).shuffle).toBe(false);
        expect(derivePlayState({ PlayState: {} }).shuffle).toBe(false);
    });
});

describe('mirrorSession queue-cache stability', () => {
    /**
     * Regression: when NowPlayingQueue exceeds MAX_QUEUE_HYDRATE (200 items),
     * the per-device cache previously stored only the truncated post-hydrate
     * ids while comparing against the full incoming list, so every poll tick
     * saw `queueChanged === true` and scheduled another hydrate forever.
     * The fix truncates the comparison set so an unchanged oversized queue
     * is recognised as stable.
     */
    it('does not re-hydrate when an oversized queue is unchanged between ticks', () => {
        const queueIds = Array.from({ length: 300 }, (_, i) => `item-${i}`);
        const NowPlayingQueue = queueIds.map((Id) => ({ Id }));
        const session = {
            NowPlayingItem: { Id: 'item-0', Name: 'first' },
            NowPlayingQueue,
            PlayState: {},
            SupportedCommands: [],
        };

        const first = mirrorSession(session, fakeServer, []);
        // First call: cache empty → hydrate scheduled.
        expect(first.hydrateQueue).not.toBeNull();
        // Simulate the sink storing the truncated ids it just hydrated.
        const cachedAfterFirst = queueIds.slice(0, 200);

        const second = mirrorSession(session, fakeServer, cachedAfterFirst);
        // Same payload, same cache → must NOT schedule a hydrate.
        expect(second.hydrateQueue).toBeNull();
    });

    it('still recognises a genuinely changed queue after a truncated hydrate', () => {
        const baseQueueIds = Array.from({ length: 300 }, (_, i) => `a-${i}`);
        const newQueueIds = Array.from({ length: 300 }, (_, i) => `b-${i}`);
        const cached = baseQueueIds.slice(0, 200);

        const result = mirrorSession(
            {
                NowPlayingItem: { Id: 'b-0' },
                NowPlayingQueue: newQueueIds.map((Id) => ({ Id })),
                PlayState: {},
                SupportedCommands: [],
            },
            fakeServer,
            cached,
        );
        expect(result.hydrateQueue).not.toBeNull();
    });

    /**
     * A1: for an oversized queue whose now-playing item sits PAST the hydrated
     * window (index >= MAX_QUEUE_HYDRATE), queueIndex must resolve against the
     * truncated window — yielding -1 ("unknown") rather than an index that
     * points past the hydrated array and breaks the queue-panel highlight.
     */
    it('does not return a queueIndex past the hydrated window for an oversized queue (A1)', () => {
        const queueIds = Array.from({ length: 300 }, (_, i) => `item-${i}`);
        const result = mirrorSession(
            {
                NowPlayingItem: { Id: 'item-247' }, // beyond the 200-item window
                NowPlayingQueue: queueIds.map((Id) => ({ Id })),
                PlayState: {},
                SupportedCommands: [],
            },
            fakeServer,
            [],
        );
        // -1 (unknown), never 247 which would index past the truncated queue.
        expect(result.queueIndex).toBe(-1);
    });

    it('resolves queueIndex within the window when the current item is inside it (A1)', () => {
        const queueIds = Array.from({ length: 300 }, (_, i) => `item-${i}`);
        const result = mirrorSession(
            {
                NowPlayingItem: { Id: 'item-12' },
                NowPlayingQueue: queueIds.map((Id) => ({ Id })),
                PlayState: {},
                SupportedCommands: [],
            },
            fakeServer,
            [],
        );
        expect(result.queueIndex).toBe(12);
    });
});

describe('mirrorSession empty-queue clear (A2)', () => {
    /**
     * A2: when the target's NowPlayingQueue transitions from N items to 0
     * (playback stopped / queue cleared), the mirror must signal an empty
     * queue so the sink clears the stale list — previously both queue branches
     * were gated on `queueIds.length > 0`, so the defunct list lived forever.
     */
    it('signals an empty queue + reset index on the N->0 transition', () => {
        const prevIds = Array.from({ length: 5 }, (_, i) => `item-${i}`);
        const result = mirrorSession(
            {
                NowPlayingItem: null,
                NowPlayingQueue: [],
                PlayState: {},
                SupportedCommands: [],
            },
            fakeServer,
            prevIds,
        );
        expect(result.hydrateQueue).toBeNull();
        expect(result.queueIds).toEqual([]);
        expect(result.queueIndex).toBe(-1);
    });

    it('does not re-signal an empty queue once it has already settled to empty', () => {
        const result = mirrorSession(
            {
                NowPlayingItem: null,
                NowPlayingQueue: [],
                PlayState: {},
                SupportedCommands: [],
            },
            fakeServer,
            [], // cache already empty → queueChanged is false
        );
        // No empty-clear signal (queueIds left undefined) → sink does nothing.
        expect(result.queueIds).toBeUndefined();
        expect(result.queueIndex).toBe(-1);
    });
});
