/**
 * Pins the upcoming-cover prefetch contract: while a song plays, the
 * fullScreen variant of the next queue items' covers is resolved through the
 * shared thumbnail pipeline (so opening the fullscreen player / skipping
 * paints instantly), deduped per image, and never started before playback is
 * audibly flowing.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const state = {
        getQueue: () => ({ items: state.queueItems }),
        player: { index: 0 },
        queueItems: [] as Array<{
            _serverId: string;
            _uniqueId: string;
            id: string;
            imageId: null | string;
        }>,
    };
    return {
        flowingResolvers: [] as Array<() => void>,
        playerState: state,
        playerSubscribers: new Set<() => void>(),
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

const song = (id: string, imageId: null | string = null) => ({
    _serverId: 'srv',
    _uniqueId: `u-${id}`,
    id,
    imageId: imageId ?? `img-${id}`,
});

describe('usePrefetchUpcomingCovers', () => {
    beforeEach(() => {
        mocks.resolveThumbnail.mockClear();
        mocks.waitForPlaybackFlowing.mockClear();
        mocks.flowingResolvers.length = 0;
        mocks.playerSubscribers.clear();
        mocks.playerState.queueItems = [];
        mocks.playerState.player.index = 0;
    });

    it('prefetches the fullScreen variant of the next songs once playback flows', async () => {
        mocks.playerState.queueItems = [song('a'), song('b'), song('c'), song('d')];
        renderHook(() => usePrefetchUpcomingCovers());

        // Nothing before playback flows.
        await new Promise((r) => setTimeout(r, 20));
        expect(mocks.resolveThumbnail).not.toHaveBeenCalled();

        mocks.flowingResolvers.forEach((r) => r());
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(2));
        const calls = mocks.resolveThumbnail.mock.calls as unknown as Array<[string, string]>;
        expect(calls.map((c) => c[0])).toEqual(['img-b', 'img-c']);
        expect(calls.every((c) => c[1] === 'fullScreen')).toBe(true);
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
            { _serverId: 'srv', _uniqueId: 'u-x', id: 'x', imageId: null },
            song('c'),
        ];
        renderHook(() => usePrefetchUpcomingCovers());
        mocks.flowingResolvers.forEach((r) => r());
        await waitFor(() => expect(mocks.resolveThumbnail).toHaveBeenCalledTimes(1));
        expect((mocks.resolveThumbnail.mock.calls[0] as unknown as [string])[0]).toBe('img-c');
    });
});
