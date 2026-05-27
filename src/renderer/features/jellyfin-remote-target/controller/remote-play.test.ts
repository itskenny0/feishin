import { describe, expect, it } from 'vitest';

import {
    computeRemotePlay,
    computeTransfer,
    interpolatePositionMs,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { Play, PlayerShuffle } from '/@/shared/types/types';

const songs = (...ids: string[]) => ids.map((id) => ({ id }));

describe('computeRemotePlay', () => {
    it('maps Play.NOW to PlayNow with no startIndex when no playSongId', () => {
        expect(computeRemotePlay(songs('a', 'b', 'c'), Play.NOW)).toEqual({
            itemIds: ['a', 'b', 'c'],
            playCommand: 'PlayNow',
            startIndex: undefined,
        });
    });

    it('resolves startIndex from playSongId for PlayNow', () => {
        expect(computeRemotePlay(songs('a', 'b', 'c'), Play.NOW, 'b')).toEqual({
            itemIds: ['a', 'b', 'c'],
            playCommand: 'PlayNow',
            startIndex: 1,
        });
    });

    it('does not set startIndex when playSongId is the first item', () => {
        expect(computeRemotePlay(songs('a', 'b'), Play.NOW, 'a')?.startIndex).toBeUndefined();
    });

    it('maps Play.NEXT and Play.LAST and ignores playSongId for them', () => {
        expect(computeRemotePlay(songs('a'), Play.NEXT, 'a')?.playCommand).toBe('PlayNext');
        expect(computeRemotePlay(songs('a'), Play.LAST)?.playCommand).toBe('PlayLast');
        expect(computeRemotePlay(songs('a'), Play.NEXT, 'a')?.startIndex).toBeUndefined();
    });

    it('returns null for empty songs', () => {
        expect(computeRemotePlay([], Play.NOW)).toBeNull();
    });

    it('returns null for reorder-edge AddToQueueType objects (local-only)', () => {
        expect(computeRemotePlay(songs('a'), { edge: 'top', uniqueId: 'x' } as never)).toBeNull();
    });
});

const baseState = (over: any = {}) => ({
    player: { index: 0, shuffle: PlayerShuffle.NONE, ...over.player },
    queue: {
        default: ['u1', 'u2', 'u3'],
        shuffled: [],
        songs: { u1: { id: 's1' }, u2: { id: 's2' }, u3: { id: 's3' } },
        ...over.queue,
    },
});

describe('computeTransfer', () => {
    it('returns ordered itemIds, current index and ticks (no shuffle)', () => {
        const t = computeTransfer(baseState({ player: { index: 1 } }) as never, 12.5);
        expect(t).toEqual({
            itemIds: ['s1', 's2', 's3'],
            startIndex: 1,
            startPositionTicks: 125_000_000,
        });
    });

    it('uses shuffled playback order and treats index as shuffled position', () => {
        const t = computeTransfer(
            baseState({
                player: { index: 0, shuffle: PlayerShuffle.TRACK },
                queue: {
                    default: ['u1', 'u2', 'u3'],
                    shuffled: [2, 0, 1],
                    songs: { u1: { id: 's1' }, u2: { id: 's2' }, u3: { id: 's3' } },
                },
            }) as never,
            0,
        );
        expect(t).toEqual({
            itemIds: ['s3', 's1', 's2'],
            startIndex: 0,
            startPositionTicks: 0,
        });
    });

    it('clamps an out-of-range index', () => {
        const t = computeTransfer(baseState({ player: { index: 99 } }) as never, 0);
        expect(t?.startIndex).toBe(2);
    });

    it('returns null for an empty queue', () => {
        const t = computeTransfer(
            baseState({ queue: { default: [], shuffled: [], songs: {} } }) as never,
            0,
        );
        expect(t).toBeNull();
    });
});

describe('interpolatePositionMs', () => {
    const ps = (over: any = {}) => ({
        isPaused: false,
        positionMs: 5_000,
        positionSampledAt: 1_000,
        repeatMode: 'RepeatNone',
        volume: 100,
        ...over,
    });

    it('returns the raw position when paused', () => {
        expect(interpolatePositionMs(ps({ isPaused: true }), 9_999, undefined)).toBe(5_000);
    });

    it('advances by elapsed wall-clock when playing', () => {
        // sampled at t=1000 with 5000ms; now t=3500 -> +2500ms
        expect(interpolatePositionMs(ps(), 3_500, undefined)).toBe(7_500);
    });

    it('never goes backwards if the clock is behind the sample', () => {
        expect(interpolatePositionMs(ps(), 500, undefined)).toBe(5_000);
    });

    it('clamps to duration when provided', () => {
        expect(interpolatePositionMs(ps(), 100_000, 6_000)).toBe(6_000);
    });

    it('returns raw position when never sampled (sampledAt 0)', () => {
        expect(interpolatePositionMs(ps({ positionSampledAt: 0 }), 3_500, undefined)).toBe(5_000);
    });
});
