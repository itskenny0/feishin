// Regression tests: queue actions that rebuild the shuffled play order must
// keep the current song current.
//
// Coordinate model: `queue.shuffled[]` holds indexes INTO `queue.default`, and
// `player.index` is a position WITHIN `queue.shuffled` when shuffle is on.
// Several actions read `player.index` as a default-order index or regenerated
// `queue.shuffled` without moving `player.index`, so the playing song silently
// switched to another one.

import { afterEach, describe, expect, it } from 'vitest';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { QueueSong, Song } from '/@/shared/types/domain-types';
import { Play, PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

const song = (id: string, albumId = 'album', duration = 200_000) =>
    ({
        _serverId: 'srv',
        _uniqueId: id,
        albumId,
        duration,
        id,
        itemType: 'song',
        name: id,
    }) as unknown as QueueSong;

const newSong = (id: string) => {
    const { _uniqueId, ...rest } = song(id);
    return rest as unknown as Song;
};

const state = () => usePlayerStoreBase.getState();
const currentId = () => state().getCurrentSong()?.id;
const isPermutationOfQueue = () => {
    const { queue } = state();
    return (
        [...queue.shuffled].sort((a, b) => a - b).join() === queue.default.map((_, i) => i).join()
    );
};

const seed = (
    songs: QueueSong[],
    options: { index: number; shuffle: PlayerShuffle; shuffled?: number[] },
) => {
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: options.index, shuffle: options.shuffle },
        queue: {
            ...s.queue,
            default: songs.map((s) => s._uniqueId),
            priority: [],
            shuffled: options.shuffled ?? [],
            songs: Object.fromEntries(songs.map((s) => [s._uniqueId, s])),
        },
    }));
};

// default order: s0 s1 s2 s3 s4
// shuffled idx:  [2, 0, 4, 1, 3] -> playback order: s2 s0 s4 s1 s3
// player.index = 3 -> current song s1, while default index 3 is s3
const SONGS = ['s0', 's1', 's2', 's3', 's4'].map((id) => song(id));
const seedShuffled = () =>
    seed(SONGS, { index: 3, shuffle: PlayerShuffle.TRACK, shuffled: [2, 0, 4, 1, 3] });

afterEach(() => {
    state().clearQueue();
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: -1, repeat: PlayerRepeat.NONE, shuffle: PlayerShuffle.NONE },
    }));
    useTimestampStoreBase.setState({ timestamp: 0 });
});

describe('reshuffling keeps the current song', () => {
    it('shuffleAll under shuffle', () => {
        seedShuffled();
        expect(currentId()).toBe('s1');

        for (let run = 0; run < 20; run += 1) {
            state().shuffleAll();
            expect(currentId()).toBe('s1');
            expect(isPermutationOfQueue()).toBe(true);
        }
    });

    it('shuffleSelected under shuffle', () => {
        seedShuffled();

        state().shuffleSelected([song('s0'), song('s1'), song('s2'), song('s3'), song('s4')]);

        expect(currentId()).toBe('s1');
        expect(isPermutationOfQueue()).toBe(true);
    });

    it('shuffleSelected without shuffle, when the selection includes the current song', () => {
        seed(SONGS, { index: 1, shuffle: PlayerShuffle.NONE });

        for (let run = 0; run < 20; run += 1) {
            state().shuffleSelected([song('s0'), song('s1'), song('s2')]);
            expect(currentId()).toBe('s1');
        }
    });

    it('setShuffle(TRACK) while shuffle is already on (remote / home assistant / peer)', () => {
        seedShuffled();

        state().setShuffle(PlayerShuffle.TRACK);

        expect(currentId()).toBe('s1');
        expect(isPermutationOfQueue()).toBe(true);
    });
});

describe('setQueue (restore) under shuffle', () => {
    it('plays the song at the restored default-order index, not a stale shuffled slot', () => {
        const old = Array.from({ length: 10 }, (_, i) => song(`old${i}`));
        seed(old, {
            index: 0,
            shuffle: PlayerShuffle.TRACK,
            shuffled: [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
        });

        state().setQueue([newSong('r0'), newSong('r1'), newSong('r2')], 1, 0);

        expect(currentId()).toBe('r1');
        expect(isPermutationOfQueue()).toBe(true);
    });
});

describe('appending to a cleared queue with shuffle on', () => {
    it('Play.LAST then Play.LAST_SHUFFLE keeps the current song and a full shuffled order', () => {
        seed([], { index: -1, shuffle: PlayerShuffle.TRACK });

        state().addToQueueByType([newSong('a'), newSong('b'), newSong('c')], Play.LAST);
        state().mediaPlayByIndex(1);
        expect(currentId()).toBe('b');

        state().addToQueueByType([newSong('d'), newSong('e')], Play.LAST_SHUFFLE);

        expect(currentId()).toBe('b');
        expect(isPermutationOfQueue()).toBe(true);
    });

    it('Play.NEXT into an empty queue builds a full shuffled order', () => {
        seed([], { index: -1, shuffle: PlayerShuffle.TRACK });

        state().addToQueueByType([newSong('a'), newSong('b')], Play.NEXT);

        expect(state().queue.default).toHaveLength(2);
        expect(isPermutationOfQueue()).toBe(true);
    });
});

describe('mediaSkipForward under shuffle', () => {
    it('clamps against the CURRENT song duration, not the song at the same default index', () => {
        // default: short (60s), long (300s); playback order: long, short
        seed([song('short', 'a', 60_000), song('long', 'a', 300_000)], {
            index: 0,
            shuffle: PlayerShuffle.TRACK,
            shuffled: [1, 0],
        });
        expect(currentId()).toBe('long');
        useTimestampStoreBase.setState({ timestamp: 120 });

        state().mediaSkipForward(10);

        expect(useTimestampStoreBase.getState().timestamp).toBe(130);
    });
});

describe('mediaPrevious', () => {
    it('a quick second press goes to the previous song instead of restarting again', () => {
        seed(SONGS, { index: 2, shuffle: PlayerShuffle.NONE });
        useTimestampStoreBase.setState({ timestamp: 30 });

        state().mediaPrevious(false);
        expect(currentId()).toBe('s2');
        expect(useTimestampStoreBase.getState().timestamp).toBe(0);

        // The engine has not reported the new position yet
        state().mediaPrevious(false);
        expect(currentId()).toBe('s1');
    });
});

describe('album skip', () => {
    // default order: a1 a2 b1 b2 c1
    const ALBUM_SONGS = [
        song('a1', 'A'),
        song('a2', 'A'),
        song('b1', 'B'),
        song('b2', 'B'),
        song('c1', 'C'),
    ];

    it('next album without shuffle jumps to the first song of the next album', () => {
        seed(ALBUM_SONGS, { index: 0, shuffle: PlayerShuffle.NONE });

        state().mediaNext(true);

        expect(currentId()).toBe('b1');
    });

    it('next album under shuffle follows the playback order', () => {
        // playback order: c1 a2 a1 b2 b1 -> current a2, next album in playback order is b2
        seed(ALBUM_SONGS, { index: 1, shuffle: PlayerShuffle.TRACK, shuffled: [4, 1, 0, 3, 2] });
        expect(currentId()).toBe('a2');

        state().mediaNext(true);

        expect(currentId()).toBe('b2');
    });

    it('previous album under shuffle follows the playback order', () => {
        // playback order: c1 a2 a1 b2 b1 -> current b1, previous album run is a2 a1
        seed(ALBUM_SONGS, { index: 4, shuffle: PlayerShuffle.TRACK, shuffled: [4, 1, 0, 3, 2] });
        expect(currentId()).toBe('b1');

        state().mediaPrevious(true);

        expect(currentId()).toBe('a2');
    });

    it('next album in a single-album queue keeps a current song', () => {
        seed([song('x1', 'X'), song('x2', 'X'), song('x3', 'X')], {
            index: 0,
            shuffle: PlayerShuffle.NONE,
        });

        state().mediaNext(true);

        expect(currentId()).toBeDefined();
        expect(state().player.index).toBeGreaterThanOrEqual(0);
    });
});
