import { describe, expect, it, vi } from 'vitest';

import { derivePlayState } from '/@/renderer/features/jellyfin-remote-target/controller/remote-state-mirror';

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
