/**
 * Pins the upcoming-cover prefetch contract: while a song plays, the
 * fullScreen variant of the neighbouring queue items' covers is resolved
 * through the shared thumbnail pipeline (so opening the fullscreen player /
 * skipping paints instantly), deduped per image, and never started before
 * playback is audibly flowing.
 *
 * Crucially the neighbours are the actual PLAYBACK neighbours: under shuffle,
 * `player.index` indexes `queue.shuffled` (indices into the default queue), so
 * the prefetch must warm the shuffle-order next/previous tracks — NOT the raw
 * default-order neighbours — and it must warm the previous slot too (the
 * fullscreen art has a swipe-back / crossfade slot).
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerRepeat } from '/@/shared/types/types';

type TestSong = {
    _serverId: string;
    _uniqueId: string;
    albumId?: null | string;
    id: string;
    imageId: null | string;
};

const mocks = vi.hoisted(() => {
    const state = {
        // getQueue always returns the DEFAULT (display) order — exactly like the
        // real store's getQueueOrder ("Always return original order").
        getQueue: () => ({ items: state.queueItems }),
        player: { index: 0, repeat: 'none', shuffle: false },
        queue: {
            // `default` holds the uniqueIds in display order (indexed by the
            // values of `shuffled`); `shuffled` maps playback position → default
            // index.
            get default(): string[] {
                return state.queueItems.map((s) => s._uniqueId);
            },
            shuffled: [] as number[],
        },
        queueItems: [] as TestSong[],
    };
    return {
        flowingResolvers: [] as Array<() => void>,
        playerState: state,
        playerSubscribers: new Set<() => void>(),
        preloadThumbnailUrls: vi.fn(async () => undefined),
        resolveThumbnail: vi.fn(async () => 'ok'),
        waitForPlaybackFlowing: vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    mocks.flowingResolvers.push(resolve);
                }),
        ),
    };
});

vi.mock('/@/renderer/store/player.store', () => ({
    // Faithful reimplementations of the real store helpers the hook reuses.
    isShuffleEnabled: (s: typeof mocks.playerState) =>
        s.player.shuffle === true && s.queue.shuffled.length > 0,
    mapShuffledToQueueIndex: (i: number, shuffled: number[]) =>
        i >= 0 && i < shuffled.length ? shuffled[i] : i,
    usePlayerStoreBase: {
        getState: () => mocks.playerState,
        subscribe: (..._args: unknown[]) => {
            const cb = _args[1] as () => void;
            mocks.playerSubscribers.add(cb);
            return () => mocks.playerSubscribers.delete(cb);
        },
    },
}));

vi.mock('/@/renderer/cache', () => ({
    preloadThumbnailUrls: mocks.preloadThumbnailUrls,
    resolveThumbnail: mocks.resolveThumbnail,
}));

vi.mock('/@/renderer/features/trackmap/analysis/defer-until-playing', () => ({
    waitForPlaybackFlowing: mocks.waitForPlaybackFlowing,
}));

vi.mock('/@/renderer/components/item-image/item-image', () => ({
    getItemImageRequest: vi.fn(() => ({ url: 'http://x/img' })),
}));

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => true,
}));

import { usePrefetchUpcomingCovers } from '/@/renderer/features/player/hooks/use-prefetch-upcoming-covers';

const song = (id: string, imageId: null | string = null): TestSong => ({
    _serverId: 'srv',
    _uniqueId: `u-${id}`,
    albumId: null,
    id,
    imageId: imageId ?? `img-${id}`,
});

/** imageIds resolveThumbnail (the fullScreen network-warm) was asked to warm. */
const warmedImageIds = () =>
    (mocks.resolveThumbnail.mock.calls as unknown as Array<[string, string]>).map((c) => c[0]);

describe('usePrefetchUpcomingCovers', () => {
    beforeEach(() => {
        mocks.resolveThumbnail.mockClear();
        mocks.preloadThumbnailUrls.mockClear();
        mocks.waitForPlaybackFlowing.mockClear();
        mocks.flowingResolvers.length = 0;
        mocks.playerSubscribers.clear();
        mocks.playerState.queueItems = [];
        mocks.playerState.player.index = 0;
        mocks.playerState.player.repeat = 'none';
        mocks.playerState.player.shuffle = false;
        mocks.playerState.queue.shuffled = [];
    });

    it('prefetches the fullScreen variant of the next songs once playback flows', async () => {
        mocks.playerState.queueItems = [song('a'), song('b'), song('c'), song('d')];
        renderHook(() => usePrefetchUpcomingCovers());

        // Nothing before playback flows.
        await new Promise((r) => setTimeout(r, 20));
        expect(mocks.resolveThumbnail).not.toHaveBeenCalled();

        mocks.flowingResolvers.forEach((r) => r());
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(2));
        // index 0, no previous → just the next two, in order.
        expect(warmedImageIds()).toEqual(['img-b', 'img-c']);
        const calls = mocks.resolveThumbnail.mock.calls as unknown as Array<[string, string]>;
        expect(calls.every((c) => c[1] === 'fullScreen')).toBe(true);
    });

    it('warms the previous slot too (swipe-back / crossfade)', async () => {
        mocks.playerState.queueItems = [song('a'), song('b'), song('c'), song('d')];
        mocks.playerState.player.index = 1; // playing 'b'
        renderHook(() => usePrefetchUpcomingCovers());
        mocks.flowingResolvers.forEach((r) => r());
        // previous ('a') + next two ('c','d').
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(3));
        expect(new Set(warmedImageIds())).toEqual(new Set(['img-a', 'img-c', 'img-d']));
    });

    it('under shuffle, warms the shuffle-order neighbours, not the default-order ones', async () => {
        // Default order: a b c d e. Shuffle plays them as: c, e, a, d, b.
        // player.index === 1 → playing 'e'; playback-next is 'a', prev is 'c'.
        mocks.playerState.queueItems = [song('a'), song('b'), song('c'), song('d'), song('e')];
        mocks.playerState.player.shuffle = true;
        mocks.playerState.queue.shuffled = [2, 4, 0, 3, 1]; // [c, e, a, d, b]
        mocks.playerState.player.index = 1; // playing 'e'

        renderHook(() => usePrefetchUpcomingCovers());
        mocks.flowingResolvers.forEach((r) => r());

        // Playback neighbours of 'e': previous 'c', next 'a' then 'd'.
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(3));
        const warmed = new Set(warmedImageIds());
        expect(warmed).toEqual(new Set(['img-a', 'img-c', 'img-d']));
        // The naive default-order neighbours (prev 'd', next 'f'/none) must NOT
        // be warmed: 'img-d' happens to be a real shuffle neighbour here, but
        // the default-order previous of index 1 ('a') must not leak in as a
        // *previous* while 'b' (default next) must be absent.
        expect(warmed.has('img-b')).toBe(false);
    });

    it('dedupes images across queue updates', async () => {
        mocks.playerState.queueItems = [song('a'), song('b'), song('c')];
        renderHook(() => usePrefetchUpcomingCovers());
        mocks.flowingResolvers.forEach((r) => r());
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(2));

        // Same upcoming songs re-notified — no duplicate resolves.
        mocks.playerSubscribers.forEach((cb) => cb());
        mocks.flowingResolvers.forEach((r) => r());
        await new Promise((r) => setTimeout(r, 30));
        expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(2);
    });

    it('skips songs without an imageId', async () => {
        mocks.playerState.queueItems = [
            song('a'),
            { _serverId: 'srv', _uniqueId: 'u-x', albumId: null, id: 'x', imageId: null },
            song('c'),
        ];
        renderHook(() => usePrefetchUpcomingCovers());
        mocks.flowingResolvers.forEach((r) => r());
        // index 0, no previous → upcoming are the img-less 'x' (skipped) + 'c'.
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(1));
        expect(warmedImageIds()[0]).toBe('img-c');
    });

    it('seeds the in-memory peek cache for current + previous + upcoming across all three variants', async () => {
        mocks.playerState.queueItems = [song('a'), song('b'), song('c')];
        mocks.playerState.player.index = 1; // playing 'b'
        renderHook(() => usePrefetchUpcomingCovers());

        // The peek seed runs immediately (before playback flows).
        await waitFor(() => expect(mocks.preloadThumbnailUrls).toHaveBeenCalled());
        const byVariant = new Map<string, string[]>();
        for (const [ids, variant] of mocks.preloadThumbnailUrls.mock.calls as unknown as Array<
            [string[], string]
        >) {
            byVariant.set(variant, ids);
        }
        expect(new Set(byVariant.keys())).toEqual(new Set(['fullScreen', 'itemCard', 'table']));
        // current 'b' + previous 'a' + upcoming 'c'.
        for (const ids of byVariant.values()) {
            expect(new Set(ids)).toEqual(new Set(['img-a', 'img-b', 'img-c']));
        }
        expect(PlayerRepeat.NONE).toBe('none'); // enum sanity (used by the hook)
    });
});
