// Regression test for the NaN insert-position bug in addToQueueByType under
// shuffle. When shuffle is ON but nothing is playing (player.index === -1),
// `shuffled[-1]` is undefined, so `shuffled[index] + 1` was NaN and
// `default.slice(0, NaN)` silently dropped the ENTIRE existing queue, leaving
// only the newly-added items. The fix falls back to inserting at the front.

import { afterEach, describe, expect, it } from 'vitest';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { Song } from '/@/shared/types/domain-types';
import { Play, PlayerShuffle } from '/@/shared/types/types';

const queueSong = (id: string) =>
    ({
        _serverId: 'srv',
        _uniqueId: id,
        duration: 200_000,
        id,
        itemType: 'song',
        name: id,
    }) as unknown as Song;

const newSong = (id: string) =>
    ({
        _serverId: 'srv',
        duration: 200_000,
        id,
        itemType: 'song',
        name: id,
    }) as unknown as Song;

const seedShuffledQueueWithNothingPlaying = () => {
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: -1, shuffle: PlayerShuffle.TRACK },
        queue: {
            ...s.queue,
            default: ['e0', 'e1'],
            shuffled: [0, 1],
            songs: { e0: queueSong('e0'), e1: queueSong('e1') },
        },
    }));
};

afterEach(() => {
    usePlayerStoreBase.getState().clearQueue();
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: -1, shuffle: PlayerShuffle.NONE },
    }));
});

describe('addToQueueByType under shuffle with nothing playing (index -1)', () => {
    it('Play.NEXT keeps the existing queue instead of dropping it (NaN guard)', () => {
        seedShuffledQueueWithNothingPlaying();

        usePlayerStoreBase.getState().addToQueueByType([newSong('n0')], Play.NEXT);

        const { queue } = usePlayerStoreBase.getState();
        // Before the fix this was length 1 (just the new item) — the existing
        // queue was sliced away by slice(0, NaN).
        expect(queue.default).toHaveLength(3);
        expect(queue.default).toContain('e0');
        expect(queue.default).toContain('e1');
    });

    it('Play.NEXT_SHUFFLE keeps the existing queue instead of dropping it', () => {
        seedShuffledQueueWithNothingPlaying();

        usePlayerStoreBase.getState().addToQueueByType([newSong('n0')], Play.NEXT_SHUFFLE);

        const { queue } = usePlayerStoreBase.getState();
        expect(queue.default).toHaveLength(3);
        expect(queue.default).toContain('e0');
        expect(queue.default).toContain('e1');
    });
});
