/**
 * Regression coverage for jump-to-current / follow-current scrolling to the
 * WRONG row when shuffle is on.
 *
 * Bug (queue view "go to current" button): `handleJumpToCurrent` scrolled to the
 * raw `player.index`. With shuffle on, `player.index` is a position into
 * `queue.shuffled`, NOT into the default display order the table renders — so it
 * jumped to the wrong song. `getVisibleCurrentIndex` maps the playback index to
 * the actual visible row (matching the follow-current logic), accounting for
 * `queueInPlaybackOrder`.
 */
import { describe, expect, it } from 'vitest';

import { getVisibleCurrentIndex } from '/@/renderer/store/player.store';
import { PlayerShuffle } from '/@/shared/types/types';

type MockState = Parameters<typeof getVisibleCurrentIndex>[0];

const makeState = (opts: {
    index: number;
    shuffle: PlayerShuffle;
    shuffled: number[];
    visibleLength: number;
}): MockState => ({
    getVisibleQueue: () =>
        ({
            groups: [],
            items: Array.from({ length: opts.visibleLength }, (_, i) => ({ _uniqueId: `u${i}` })),
        }) as any,
    player: { index: opts.index, shuffle: opts.shuffle },
    queue: { shuffled: opts.shuffled },
});

describe('getVisibleCurrentIndex', () => {
    it('returns player.index directly when shuffle is off', () => {
        const state = makeState({
            index: 3,
            shuffle: PlayerShuffle.NONE,
            shuffled: [],
            visibleLength: 10,
        });
        expect(getVisibleCurrentIndex(state, false)).toBe(3);
        expect(getVisibleCurrentIndex(state, true)).toBe(3);
    });

    it('maps shuffled playback index to default-order row when NOT showing playback order', () => {
        // shuffled[0]=4 means the first-played track is row 4 in default order.
        const state = makeState({
            index: 0,
            shuffle: PlayerShuffle.TRACK,
            shuffled: [4, 2, 0, 1, 3],
            visibleLength: 5,
        });
        // queueInPlaybackOrder=false → visible is default order → row 4.
        expect(getVisibleCurrentIndex(state, false)).toBe(4);
    });

    it('uses player.index directly when showing playback order with shuffle on', () => {
        const state = makeState({
            index: 0,
            shuffle: PlayerShuffle.TRACK,
            shuffled: [4, 2, 0, 1, 3],
            visibleLength: 5,
        });
        // queueInPlaybackOrder=true → visible IS shuffled order → row 0.
        expect(getVisibleCurrentIndex(state, true)).toBe(0);
    });

    it('proves the old raw-index behavior was wrong (shuffle + default order)', () => {
        const state = makeState({
            index: 1,
            shuffle: PlayerShuffle.TRACK,
            shuffled: [4, 2, 0, 1, 3],
            visibleLength: 5,
        });
        // Raw player.index would have scrolled to row 1, but the current song is
        // actually at default-order row shuffled[1]=2.
        expect(getVisibleCurrentIndex(state, false)).toBe(2);
        expect(getVisibleCurrentIndex(state, false)).not.toBe(state.player.index);
    });

    it('returns -1 when the index is out of the visible range (e.g. empty queue)', () => {
        const empty = makeState({
            index: 0,
            shuffle: PlayerShuffle.NONE,
            shuffled: [],
            visibleLength: 0,
        });
        expect(getVisibleCurrentIndex(empty, false)).toBe(-1);

        const negative = makeState({
            index: -1,
            shuffle: PlayerShuffle.NONE,
            shuffled: [],
            visibleLength: 5,
        });
        expect(getVisibleCurrentIndex(negative, false)).toBe(-1);
    });

    it('treats shuffle as off when the shuffled array is empty (isShuffleEnabled guard)', () => {
        const state = makeState({
            index: 2,
            shuffle: PlayerShuffle.TRACK,
            shuffled: [],
            visibleLength: 5,
        });
        expect(getVisibleCurrentIndex(state, false)).toBe(2);
    });
});
