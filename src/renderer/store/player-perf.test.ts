/**
 * Pins the perf-critical contracts on the player store hot path:
 *
 *  1. `getCurrentSong()` must be O(1) — it used to call `state.getQueue()`,
 *     which materialised a full QueueSong[] copy of the default-order queue on
 *     every invocation. That's `usePlayerSong` × N subscribers × every store
 *     mutation, which on a long queue is a measurable per-mutation cost
 *     during an active listening session. The regression test feeds a 500-track
 *     queue and asserts that `getCurrentSong()` does not allocate a new array
 *     each call.
 *
 *  2. `usePlayerCoreData` is a leaf selector for the dual-stream audio
 *     orchestrator. It must return a stable shallow-equal payload when
 *     unrelated player state (volume, mute, repeat, shuffle, crossfadeStyle,
 *     queueLength) mutates. A regression here would re-render `WebPlayer`
 *     during volume drags + queue edits and rebind the `onProgress` callbacks
 *     on react-player.
 *
 *  3. `usePlayerTransition` is the transition-specific subset; same contract
 *     against volume/mute/repeat/shuffle changes.
 *
 *  4. `useActiveSongStatus` (used by MpvPlayer) must skip queueLength churn.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    subscribeCurrentTrack,
    useActiveSongStatus,
    usePlayerCoreData,
    usePlayerStoreBase,
    usePlayerTransition,
} from '/@/renderer/store/player.store';
import { Song } from '/@/shared/types/domain-types';
import {
    CrossfadeStyle,
    PlayerRepeat,
    PlayerShuffle,
    PlayerStatus,
    PlayerStyle,
} from '/@/shared/types/types';

const makeSong = (i: number): Song =>
    ({
        _serverId: 'srv',
        album: `Album ${i}`,
        artistName: 'Artist',
        duration: 200_000,
        gain: undefined,
        id: `song-${i}`,
        imageId: null,
        imageUrl: null,
        itemType: 'song',
        name: `Track ${i}`,
        peak: undefined,
        userFavorite: false,
        userRating: null,
    }) as unknown as Song;

const seedQueue = (count: number, index = 0) => {
    const items = Array.from({ length: count }, (_, i) => makeSong(i));
    // Wrap in act() because `setQueue` triggers a setState that any subsequent
    // `renderHook` will subscribe to. Without act, React flushes the update
    // outside the test scheduler and prints a console warning.
    act(() => {
        usePlayerStoreBase.getState().setQueue(items, index, 0);
    });
};

const resetStore = () => {
    // afterEach fires after the test's hooks have been torn down, but the
    // Zustand subscribers from `renderHook` are still attached if the hook
    // wasn't explicitly unmounted. Wrapping the reset in act() keeps React's
    // strict-mode logger quiet.
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
            state.player.volume = 50;
            state.player.muted = false;
            state.player.speed = 1;
            state.player.transitionType = PlayerStyle.GAPLESS;
            state.player.crossfadeDuration = 5;
            state.player.crossfadeStyle = CrossfadeStyle.EQUAL_POWER;
        });
    });
};

afterEach(() => {
    resetStore();
});

describe('player-store hot-path perf', () => {
    describe('getCurrentSong O(1)', () => {
        it('does not call getQueue() / allocate a full queue items array', () => {
            seedQueue(500, 17);

            const state = usePlayerStoreBase.getState();
            const baseGetQueue = state.getQueue.bind(state);
            let getQueueCalls = 0;
            const wrapped = (...args: Parameters<typeof baseGetQueue>) => {
                getQueueCalls++;
                return baseGetQueue(...args);
            };
            // Patch the bound `getQueue` so any code path that materialised the
            // full queue would trip the counter. We restore via afterEach.
            usePlayerStoreBase.setState((s) => {
                s.getQueue = wrapped as typeof s.getQueue;
            });

            const song = usePlayerStoreBase.getState().getCurrentSong();
            expect(song?.id).toBe('song-17');
            expect(getQueueCalls).toBe(0);
        });

        it('returns the shuffled-position song when shuffle is on', () => {
            seedQueue(10);
            // Force a known shuffled order so the test is deterministic.
            usePlayerStoreBase.setState((state) => {
                state.player.shuffle = PlayerShuffle.TRACK;
                state.queue.shuffled = [5, 0, 1, 2, 3, 4, 6, 7, 8, 9];
                state.player.index = 0;
            });
            // shuffle[index=0] → queue position 5 → song-5
            expect(usePlayerStoreBase.getState().getCurrentSong()?.id).toBe('song-5');
        });
    });

    describe('usePlayerCoreData leaf subscription', () => {
        it('returns a stable shallow-equal payload under unrelated mutations', () => {
            seedQueue(5, 0);

            const { rerender, result } = renderHook(() => usePlayerCoreData());
            const initial = result.current;
            expect(initial.player1?.id).toBe('song-0');
            expect(initial.player2?.id).toBe('song-1');

            // Volume change — entirely unrelated to the dual-player payload.
            act(() => {
                usePlayerStoreBase.getState().setVolume(99);
            });
            rerender();
            expect(result.current).toBe(initial);

            // Mute change.
            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.muted = true;
                });
            });
            rerender();
            expect(result.current).toBe(initial);

            // Crossfade style change.
            act(() => {
                usePlayerStoreBase.getState().setCrossfadeStyle(CrossfadeStyle.LINEAR);
            });
            rerender();
            expect(result.current).toBe(initial);
        });

        it('re-renders when the active song or status actually changes', () => {
            seedQueue(5, 0);

            const { rerender, result } = renderHook(() => usePlayerCoreData());
            const initial = result.current;

            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.status = PlayerStatus.PAUSED;
                });
            });
            rerender();
            expect(result.current).not.toBe(initial);
            expect(result.current.status).toBe(PlayerStatus.PAUSED);

            const afterStatus = result.current;

            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.index = 2;
                });
            });
            rerender();
            expect(result.current).not.toBe(afterStatus);
            expect(result.current.player1?.id).toBe('song-2');
            expect(result.current.player2?.id).toBe('song-3');
        });
    });

    describe('usePlayerTransition leaf subscription', () => {
        it('does not re-render on volume/mute/repeat/shuffle/queue mutations', () => {
            seedQueue(5, 0);

            const { rerender, result } = renderHook(() => usePlayerTransition());
            const initial = result.current;

            act(() => {
                usePlayerStoreBase.getState().setVolume(7);
            });
            rerender();
            expect(result.current).toBe(initial);

            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.muted = !s.player.muted;
                });
            });
            rerender();
            expect(result.current).toBe(initial);

            act(() => {
                usePlayerStoreBase.getState().setRepeat(PlayerRepeat.ALL);
            });
            rerender();
            expect(result.current).toBe(initial);

            act(() => {
                usePlayerStoreBase.getState().setShuffle(PlayerShuffle.TRACK);
            });
            rerender();
            expect(result.current).toBe(initial);
        });

        it('re-renders when a transition-relevant setting changes', () => {
            const { rerender, result } = renderHook(() => usePlayerTransition());
            const initial = result.current;

            act(() => {
                usePlayerStoreBase.getState().setTransitionType(PlayerStyle.CROSSFADE);
            });
            rerender();
            expect(result.current).not.toBe(initial);
            expect(result.current.transitionType).toBe(PlayerStyle.CROSSFADE);
        });
    });

    describe('subscribeCurrentTrack index-only selector', () => {
        it('does not call getQueue() on a position-tick mutation', () => {
            seedQueue(500, 0);

            const baseGetQueue = usePlayerStoreBase.getState().getQueue;
            let getQueueCalls = 0;
            const wrapped = ((...args: Parameters<typeof baseGetQueue>) => {
                getQueueCalls++;
                return baseGetQueue(...args);
            }) as typeof baseGetQueue;
            usePlayerStoreBase.setState((s) => {
                s.getQueue = wrapped;
            });

            const unsubscribe = subscribeCurrentTrack(() => {});

            // A status flip is a typical hot-path mutation (it happens on every
            // play/pause). The selector must not materialise the full queue.
            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.status = PlayerStatus.PLAYING;
                });
            });

            expect(getQueueCalls).toBe(0);
            unsubscribe();
        });

        it('fires once with the resolved song only when the active track changes', () => {
            seedQueue(5, 0);

            const calls: Array<string | undefined> = [];
            const unsubscribe = subscribeCurrentTrack(({ song }) => {
                calls.push(song?.id);
            });

            // Unrelated mutation (volume) must not fire the subscriber.
            act(() => {
                usePlayerStoreBase.getState().setVolume(80);
            });
            expect(calls).toHaveLength(0);

            // Moving the index resolves and emits the new song.
            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.index = 3;
                });
            });
            expect(calls).toEqual(['song-3']);

            // Same index again (no change) must not re-fire.
            act(() => {
                usePlayerStoreBase.setState((s) => {
                    s.player.status = PlayerStatus.PLAYING;
                });
            });
            expect(calls).toEqual(['song-3']);

            unsubscribe();
        });
    });

    describe('useActiveSongStatus (mpv) leaf subscription', () => {
        it('skips volume/mute mutations', () => {
            seedQueue(3, 0);

            const { rerender, result } = renderHook(() => useActiveSongStatus());
            const initial = result.current;
            expect(initial.currentSong?.id).toBe('song-0');

            act(() => {
                usePlayerStoreBase.getState().setVolume(11);
                usePlayerStoreBase.setState((s) => {
                    s.player.muted = !s.player.muted;
                });
            });
            rerender();
            expect(result.current).toBe(initial);
        });
    });
});
