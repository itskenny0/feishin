/**
 * Pins the boolean-selector contract for `useIsCurrentSong` /
 * `useIsCurrentSongPlaying`.
 *
 * The album detail list mounts these hooks in hundreds of track cells at once.
 * Each must subscribe to a *boolean* derived from the current song — not the
 * whole song object — so that a track change re-renders only the cell that
 * flips from/to active, and Zustand bails out for every other (still-false)
 * cell. This test feeds a queue, then advances the active track and asserts the
 * render counts: the active + previously-active cells update, unrelated cells
 * do not.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    useIsCurrentSong,
    useIsCurrentSongPlaying,
} from '/@/renderer/features/player/hooks/use-is-current-song';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { QueueSong, Song } from '/@/shared/types/domain-types';
import { PlayerRepeat, PlayerShuffle, PlayerStatus, PlayerStyle } from '/@/shared/types/types';

const makeSong = (i: number): Song =>
    ({
        _serverId: 'srv',
        album: `Album ${i}`,
        artistName: 'Artist',
        duration: 200_000,
        id: `song-${i}`,
        imageId: null,
        imageUrl: null,
        itemType: 'song',
        name: `Track ${i}`,
        userFavorite: false,
        userRating: null,
    }) as unknown as Song;

const seedQueue = (count: number, index = 0) => {
    const items = Array.from({ length: count }, (_, i) => makeSong(i));
    act(() => {
        usePlayerStoreBase.getState().setQueue(items, index, 0);
    });
};

const queueSongAt = (index: number): QueueSong => {
    const state = usePlayerStoreBase.getState();
    const uniqueId = state.queue.default[index];
    return state.queue.songs[uniqueId];
};

const setIndex = (index: number) => {
    act(() => {
        usePlayerStoreBase.setState((state) => {
            state.player.index = index;
        });
    });
};

const setStatus = (status: PlayerStatus) => {
    act(() => {
        usePlayerStoreBase.setState((state) => {
            state.player.status = status;
        });
    });
};

const resetStore = () => {
    act(() => {
        usePlayerStoreBase.setState((state) => {
            state.queue.default = [];
            state.queue.songs = {};
            state.queue.shuffled = [];
            state.player.index = 0;
            state.player.playerNum = 1;
            state.player.status = PlayerStatus.PAUSED;
            state.player.repeat = PlayerRepeat.NONE;
            state.player.shuffle = PlayerShuffle.NONE;
            state.player.transitionType = PlayerStyle.GAPLESS;
        });
    });
};

afterEach(() => {
    resetStore();
});

describe('useIsCurrentSong', () => {
    it('returns true only for the active queue song', () => {
        seedQueue(5, 2);

        const songActive = queueSongAt(2);
        const songInactive = queueSongAt(0);
        const active = renderHook(() => useIsCurrentSong(songActive));
        const inactive = renderHook(() => useIsCurrentSong(songInactive));

        expect(active.result.current.isActive).toBe(true);
        expect(inactive.result.current.isActive).toBe(false);
    });

    it('only re-renders the cells whose active boolean flips on a track change', () => {
        seedQueue(5, 0);

        const song0 = queueSongAt(0);
        const song1 = queueSongAt(1);
        const song4 = queueSongAt(4);

        const renders = { s0: 0, s1: 0, s4: 0 };

        renderHook(() => {
            renders.s0++;
            return useIsCurrentSong(song0);
        });
        renderHook(() => {
            renders.s1++;
            return useIsCurrentSong(song1);
        });
        renderHook(() => {
            renders.s4++;
            return useIsCurrentSong(song4);
        });

        const baseline = { ...renders };

        // Advance active track 0 -> 1: only s0 (true->false) and s1
        // (false->true) should re-render. s4 stays false and must bail out.
        setIndex(1);

        expect(renders.s0).toBe(baseline.s0 + 1);
        expect(renders.s1).toBe(baseline.s1 + 1);
        expect(renders.s4).toBe(baseline.s4);
    });

    it('falls back to id matching when the song has no _uniqueId', () => {
        seedQueue(3, 1);

        const plainSong = makeSong(1);
        const { result } = renderHook(() => useIsCurrentSong(plainSong));

        expect(result.current.isActive).toBe(true);
    });
});

describe('useIsCurrentSongPlaying', () => {
    it('is true only when the song is active AND the player is playing', () => {
        seedQueue(4, 1);
        setStatus(PlayerStatus.PAUSED);

        const songActive = queueSongAt(1);
        const songInactive = queueSongAt(0);
        const active = renderHook(() => useIsCurrentSongPlaying(songActive));
        const inactive = renderHook(() => useIsCurrentSongPlaying(songInactive));

        expect(active.result.current).toBe(false);
        expect(inactive.result.current).toBe(false);

        setStatus(PlayerStatus.PLAYING);
        active.rerender();
        inactive.rerender();

        expect(active.result.current).toBe(true);
        expect(inactive.result.current).toBe(false);
    });

    it('bails out for unrelated cells when play status toggles', () => {
        seedQueue(4, 0);
        setStatus(PlayerStatus.PLAYING);

        const song0 = queueSongAt(0);
        const song3 = queueSongAt(3);

        const renderSpy = vi.fn();
        renderHook(() => {
            renderSpy();
            return useIsCurrentSongPlaying(song3);
        });

        const callsBefore = renderSpy.mock.calls.length;

        // Pause: song3 was already false and stays false -> no re-render.
        setStatus(PlayerStatus.PAUSED);

        expect(renderSpy.mock.calls.length).toBe(callsBefore);

        // The active song's playing boolean does flip when we re-check it.
        const { result } = renderHook(() => useIsCurrentSongPlaying(song0));
        expect(result.current).toBe(false);
    });
});
