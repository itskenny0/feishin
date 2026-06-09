// Regression tests for queue reorder/remove while shuffle is ON.
//
// Coordinate model: `queue.shuffled[]` holds indexes INTO `queue.default`, and
// `player.index` is a position WITHIN `queue.shuffled` (see getCurrentSong).
// The moveSelected* actions used to rebuild `queue.default` without remapping
// `queue.shuffled`, and the shared recalculatePlayerIndex wrote a DEFAULT-order
// position into `player.index` — both corrupt playback under shuffle, so the
// wrong song plays after any reorder/remove.
//
// Semantics under shuffle:
//   - moveSelectedToTop/Bottom + drag in the default-order view reorder the
//     DISPLAY (default) order only; the playback (shuffled) order keeps
//     pointing at the same songs.
//   - moveSelectedToNext repositions the selection in BOTH orders — the songs
//     must actually play next.
//   - drag while the queue renders in playback order (queueInPlaybackOrder +
//     shuffle) reorders the SHUFFLED order — you reorder what you see.
//   - after every mutation the current song stays current.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerShuffle } from '/@/shared/types/types';

const song = (id: string) =>
    ({
        _serverId: 'srv',
        _uniqueId: id,
        duration: 200_000,
        id,
        itemType: 'song',
        name: id,
    }) as unknown as QueueSong;

const SONG_IDS = ['s0', 's1', 's2', 's3', 's4'];

// default order: s0 s1 s2 s3 s4
// shuffled idx:  [2, 0, 4, 1, 3] → playback order: s2 s0 s4 s1 s3
// player.index = 1 (position in shuffled) → current song = s0
const seedShuffledQueue = () => {
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: 1, shuffle: PlayerShuffle.TRACK },
        queue: {
            ...s.queue,
            default: [...SONG_IDS],
            shuffled: [2, 0, 4, 1, 3],
            songs: Object.fromEntries(SONG_IDS.map((id) => [id, song(id)])),
        },
    }));
};

const seedDefaultQueue = (index: number) => {
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index, shuffle: PlayerShuffle.NONE },
        queue: {
            ...s.queue,
            default: [...SONG_IDS],
            shuffled: [],
            songs: Object.fromEntries(SONG_IDS.map((id) => [id, song(id)])),
        },
    }));
};

const state = () => usePlayerStoreBase.getState();
const playbackOrderIds = () => {
    const { queue } = state();
    return queue.shuffled.map((idx) => queue.default[idx]);
};
const setQueueInPlaybackOrder = (value: boolean) => {
    useSettingsStore.setState((s) => ({
        ...s,
        general: { ...s.general, queueInPlaybackOrder: value },
    }));
};

beforeEach(() => {
    setQueueInPlaybackOrder(false);
});

afterEach(() => {
    state().clearQueue();
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: -1, shuffle: PlayerShuffle.NONE },
    }));
});

describe('clearSelected under shuffle', () => {
    it('keeps the current song current when removing a song after it', () => {
        seedShuffledQueue();

        state().clearSelected([song('s4')]);

        expect(state().getCurrentSong()?.id).toBe('s0');
        expect(playbackOrderIds()).toEqual(['s2', 's0', 's1', 's3']);
    });

    it('keeps the current song current when removing an already-played song', () => {
        seedShuffledQueue();

        state().clearSelected([song('s2')]);

        expect(state().getCurrentSong()?.id).toBe('s0');
        expect(playbackOrderIds()).toEqual(['s0', 's4', 's1', 's3']);
    });
});

describe('moveSelectedToTop/Bottom under shuffle', () => {
    it('moveSelectedToTop reorders display order without changing playback order', () => {
        seedShuffledQueue();

        state().moveSelectedToTop([song('s3')]);

        expect(state().queue.default).toEqual(['s3', 's0', 's1', 's2', 's4']);
        expect(playbackOrderIds()).toEqual(['s2', 's0', 's4', 's1', 's3']);
        expect(state().getCurrentSong()?.id).toBe('s0');
    });

    it('moveSelectedToBottom reorders display order without changing playback order', () => {
        seedShuffledQueue();

        state().moveSelectedToBottom([song('s1')]);

        expect(state().queue.default).toEqual(['s0', 's2', 's3', 's4', 's1']);
        expect(playbackOrderIds()).toEqual(['s2', 's0', 's4', 's1', 's3']);
        expect(state().getCurrentSong()?.id).toBe('s0');
    });
});

describe('moveSelectedToNext under shuffle', () => {
    it('moved songs play next in the shuffled order and follow the current song in default order', () => {
        seedShuffledQueue();

        state().moveSelectedToNext([song('s3')]);

        expect(state().getCurrentSong()?.id).toBe('s0');
        // current song s0 sits at player.index; the moved song must come right after
        const order = playbackOrderIds();
        expect(order[state().player.index]).toBe('s0');
        expect(order[state().player.index + 1]).toBe('s3');
        // default order: inserted after the current song's default position
        expect(state().queue.default).toEqual(['s0', 's3', 's1', 's2', 's4']);
    });
});

describe('moveSelectedTo (drag) under shuffle', () => {
    it('reorders the default order without changing playback order (default-order view)', () => {
        setQueueInPlaybackOrder(false);
        seedShuffledQueue();

        // drag s4 above s1 in the default-order view
        state().moveSelectedTo([song('s4')], 's1', 'top');

        expect(state().queue.default).toEqual(['s0', 's4', 's1', 's2', 's3']);
        expect(playbackOrderIds()).toEqual(['s2', 's0', 's4', 's1', 's3']);
        expect(state().getCurrentSong()?.id).toBe('s0');
    });

    it('reorders the shuffled order without changing default order (playback-order view)', () => {
        setQueueInPlaybackOrder(true);
        seedShuffledQueue();

        // visible playback order is s2 s0 s4 s1 s3; drag s3 above s4
        state().moveSelectedTo([song('s3')], 's4', 'top');

        expect(playbackOrderIds()).toEqual(['s2', 's0', 's3', 's4', 's1']);
        expect(state().queue.default).toEqual(['s0', 's1', 's2', 's3', 's4']);
        expect(state().getCurrentSong()?.id).toBe('s0');
    });
});

describe('reorder without shuffle (regression guard)', () => {
    it('moveSelectedToNext inserts after the current song and keeps it current', () => {
        seedDefaultQueue(1);

        state().moveSelectedToNext([song('s4')]);

        expect(state().queue.default).toEqual(['s0', 's1', 's4', 's2', 's3']);
        expect(state().getCurrentSong()?.id).toBe('s1');
        expect(state().player.index).toBe(1);
    });

    it('moveSelectedToTop keeps the current song current', () => {
        seedDefaultQueue(2);

        state().moveSelectedToTop([song('s4')]);

        expect(state().queue.default).toEqual(['s4', 's0', 's1', 's2', 's3']);
        expect(state().getCurrentSong()?.id).toBe('s2');
    });
});
