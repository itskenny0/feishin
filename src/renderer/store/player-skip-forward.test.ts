// Regression test for mediaSkipForward on a track with unknown duration.
// It used to early-return when the current track had no duration (radio /
// streams / metadata not yet loaded), making skip-forward a silent no-op while
// skip-backward worked. The fix advances the position without the upper clamp
// when duration is unknown.

import { afterEach, describe, expect, it } from 'vitest';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { Song } from '/@/shared/types/domain-types';
import { PlayerShuffle } from '/@/shared/types/types';

const songWithDuration = (id: string, duration: number | undefined) =>
    ({
        _serverId: 'srv',
        _uniqueId: id,
        duration,
        id,
        itemType: 'song',
        name: id,
    }) as unknown as Song;

const seedCurrent = (duration: number | undefined) => {
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: 0, shuffle: PlayerShuffle.NONE },
        queue: {
            ...s.queue,
            default: ['s0'],
            shuffled: [],
            songs: { s0: songWithDuration('s0', duration) },
        },
    }));
    useTimestampStoreBase.setState({ timestamp: 30 });
};

afterEach(() => {
    usePlayerStoreBase.getState().clearQueue();
    useTimestampStoreBase.setState({ timestamp: 0 });
});

describe('mediaSkipForward', () => {
    it('advances the position on a track with UNKNOWN duration (no longer a no-op)', () => {
        seedCurrent(undefined);
        usePlayerStoreBase.getState().mediaSkipForward(10);
        expect(useTimestampStoreBase.getState().timestamp).toBe(40);
    });

    it('still clamps just shy of the end on a track with a known duration', () => {
        seedCurrent(45);
        usePlayerStoreBase.getState().mediaSkipForward(10);
        // min(45 - 1, 30 + 10) = min(44, 40) = 40
        expect(useTimestampStoreBase.getState().timestamp).toBe(40);
        // Near the end: clamps to duration - 1.
        useTimestampStoreBase.setState({ timestamp: 44 });
        usePlayerStoreBase.getState().mediaSkipForward(10);
        expect(useTimestampStoreBase.getState().timestamp).toBe(44);
    });
});
