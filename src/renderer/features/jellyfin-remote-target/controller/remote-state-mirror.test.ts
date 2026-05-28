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
            isPaused: false,
            positionMs: 0,
            positionSampledAt: 7,
            repeatMode: 'RepeatNone',
            shuffle: false,
            volume: 100,
        });
        vi.restoreAllMocks();
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
});
