import merge from 'lodash/merge';
import { nanoid } from 'nanoid';
import { useMemo } from 'react';
import { persist, subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { useShallow } from 'zustand/react/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import { eventEmitter } from '/@/renderer/events/event-emitter';
import { useRadioStore as useRadioPlayerStore } from '/@/renderer/features/radio/hooks/use-radio-player';
import { perfLog } from '/@/renderer/lib/perf-log';
import { createSelectors } from '/@/renderer/lib/zustand';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import {
    setTimestamp as setTimestampStore,
    useTimestampStoreBase,
} from '/@/renderer/store/timestamp.store';
import { migratePlayerStorePersist, playerStoreStorage } from '/@/renderer/store/utils';
import { shuffleInPlace } from '/@/renderer/utils/shuffle';
import { PlayerData, QueueData, QueueSong, Song } from '/@/shared/types/domain-types';
import {
    CrossfadeStyle,
    Play,
    PlayerRepeat,
    PlayerShuffle,
    PlayerStatus,
    PlayerStyle,
} from '/@/shared/types/types';

export interface PlayerState extends Actions, State {}

export type QueueGroupingProperty = keyof QueueSong;

interface Actions {
    addToQueueByType: (items: Song[], playType: Play, playSongId?: string) => void;
    addToQueueByUniqueId: (
        items: Song[],
        uniqueId: string,
        edge: 'bottom' | 'top',
        playSongId?: string,
    ) => void;
    clearQueue: () => void;
    clearSelected: (items: QueueSong[]) => void;
    decreaseVolume: (value: number) => void;
    getCurrentSong: () => QueueSong | undefined;
    getPlayerData: () => PlayerData;
    getQueue: (groupBy?: QueueGroupingProperty) => GroupedQueue;
    getQueueOrder: () => {
        groups: { count: number; name: string }[];
        items: QueueSong[];
    };
    getVisibleQueue: () => GroupedQueue;
    increaseVolume: (value: number) => void;
    isFirstTrackInQueue: () => boolean;
    isLastTrackInQueue: () => boolean;
    mediaAutoNext: () => PlayerData;
    mediaNext: () => void;
    mediaPause: () => void;
    mediaPlay: (id?: string) => void;
    mediaPlayByIndex: (index: number) => void;
    mediaPrevious: () => void;
    mediaSeekToTimestamp: (timestamp: number) => void;
    mediaSkipBackward: (offset?: number) => void;
    mediaSkipForward: (offset?: number) => void;
    /**
     * @param options.reset - When true (default), sets seekToTimestamp(0) so the engine seeks to start.
     * Timestamp display is always cleared to 0. Use false when the engine is already idle (e.g. mpv `stopped`) to skip that seek.
     */
    mediaStop: (options?: { reset?: boolean }) => void;
    mediaToggleMute: () => void;
    mediaTogglePlayPause: () => void;
    moveSelectedTo: (
        items: QueueSong[],
        uniqueId: string,
        edge: 'bottom' | 'top',
        space?: 'default' | 'visible',
    ) => void;
    moveSelectedToBottom: (items: QueueSong[]) => void;
    moveSelectedToNext: (items: QueueSong[]) => void;
    moveSelectedToTop: (items: QueueSong[]) => void;
    setCrossfadeDuration: (duration: number) => void;
    setCrossfadeStyle: (style: CrossfadeStyle) => void;
    setPauseOnNextSongEnd: (value: boolean) => void;
    setQueue: (data: Song[], index?: number, position?: number) => void;
    setRepeat: (repeat: PlayerRepeat) => void;
    setShuffle: (shuffle: PlayerShuffle) => void;
    setSpeed: (speed: number) => void;
    setTransitionType: (transitionType: PlayerStyle) => void;
    setVolume: (volume: number) => void;
    shuffle: () => void;
    shuffleAll: () => void;
    shuffleSelected: (items: QueueSong[]) => void;
    toggleRepeat: () => void;
    toggleShuffle: () => void;
}

interface GroupedQueue {
    groups: { count: number; name: string }[];
    items: QueueSong[];
}

interface State {
    hydrated: boolean;
    player: {
        crossfadeDuration: number;
        crossfadeStyle: CrossfadeStyle;
        index: number;
        muted: boolean;
        pauseOnNextSongEnd: boolean;
        playerNum: 1 | 2;
        repeat: PlayerRepeat;
        seekToTimestamp: string;
        shuffle: PlayerShuffle;
        speed: number;
        status: PlayerStatus;
        transitionType: PlayerStyle;
        volume: number;
    };
    queue: QueueData;
}

// Calculates the next song based on repeat mode and current position
export function calculateNextSong(
    currentIndex: number,
    queueItems: QueueSong[],
    repeat: PlayerRepeat,
): QueueSong | undefined {
    if (queueItems.length === 0) {
        return undefined;
    }

    if (repeat === PlayerRepeat.ONE) {
        // When repeating one, next song is the same as current
        return queueItems[currentIndex];
    } else if (repeat === PlayerRepeat.ALL) {
        // When repeating all, next song wraps to first if at the end
        const isLastTrack = currentIndex === queueItems.length - 1;
        if (isLastTrack) {
            return queueItems[0];
        } else {
            return queueItems[currentIndex + 1];
        }
    } else {
        // When repeat is none, next song is undefined if at the end
        return queueItems[currentIndex + 1];
    }
}

export function getDualPlayerSongs(
    playerNum: 1 | 2,
    currentSong: QueueSong | undefined,
    nextSong: QueueSong | undefined,
    repeat: PlayerRepeat,
): { player1: QueueSong | undefined; player2: QueueSong | undefined } {
    if (repeat === PlayerRepeat.ONE) {
        return {
            player1: playerNum === 1 ? currentSong : undefined,
            player2: playerNum === 2 ? currentSong : undefined,
        };
    }

    return {
        player1: playerNum === 1 ? currentSong : nextSong,
        player2: playerNum === 2 ? currentSong : nextSong,
    };
}

/**
 * Resolves the row index of the currently-playing song WITHIN THE VISIBLE QUEUE
 * (the order the table actually renders). Use this — not the raw
 * `player.index` — for any scroll-to-current / jump-to-current affordance.
 *
 * `player.index` is the PLAYBACK position. When shuffle is on it indexes into
 * `queue.shuffled`, not into the default display order. The visible queue is:
 *   - shuffled order  when `queueInPlaybackOrder` && shuffle on  → row = player.index
 *   - default order   otherwise                                  → row = mapShuffledToQueueIndex(player.index)
 *
 * Returns -1 when the index falls outside the visible queue (e.g. empty queue).
 */
export function getVisibleCurrentIndex(
    state: {
        getVisibleQueue: () => GroupedQueue;
        player: { index: number; shuffle: PlayerShuffle };
        queue: { shuffled: number[] };
    },
    queueInPlaybackOrder: boolean,
): number {
    const visibleLength = state.getVisibleQueue().items.length;
    const shuffleOn = isShuffleEnabled(state);

    let index: number;
    if (queueInPlaybackOrder && shuffleOn) {
        // Visible queue is already in shuffled (playback) order, so the
        // playback position is the visible row directly.
        index = state.player.index;
    } else if (shuffleOn) {
        // Visible queue is in default order; translate the shuffled playback
        // position back to its default-order row.
        index = mapShuffledToQueueIndex(state.player.index, state.queue.shuffled);
    } else {
        index = state.player.index;
    }

    if (index < 0 || index >= visibleLength) return -1;
    return index;
}

// Helper function to check if shuffle is enabled
export function isShuffleEnabled(state: {
    player: { shuffle: PlayerShuffle };
    queue: { shuffled: number[] };
}): boolean {
    return state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0;
}

// Helper function to map shuffled position to actual queue position
export function mapShuffledToQueueIndex(shuffledIndex: number, shuffled: number[]): number {
    if (shuffledIndex >= 0 && shuffledIndex < shuffled.length) {
        return shuffled[shuffledIndex];
    }
    return shuffledIndex;
}

// Helper function to add new indexes to shuffled array after current position
function addIndexesToShuffled(
    shuffled: number[],
    currentShuffledIndex: number,
    newIndexes: number[],
): number[] {
    // Keep everything before and including current position
    const beforeCurrent = shuffled.slice(0, currentShuffledIndex + 1);
    // Shuffle everything after current position plus new indexes
    const afterCurrent = shuffled.slice(currentShuffledIndex + 1);
    const toShuffle = [...afterCurrent, ...newIndexes];
    return [...beforeCurrent, ...shuffleInPlace(toShuffle)];
}

// Helper function to adjust shuffled indexes when items are inserted
function adjustShuffledIndexesForInsertion(
    shuffled: number[],
    insertPosition: number,
    insertCount: number,
): number[] {
    return shuffled.map((idx) => {
        if (idx >= insertPosition) {
            return idx + insertCount;
        }
        return idx;
    });
}

// Calculates the next index based on repeat mode and current position
function calculateNextIndex(
    currentIndex: number,
    queueLength: number,
    repeat: PlayerRepeat,
): { nextIndex: number; shouldStop: boolean } {
    const isLastTrack = currentIndex === queueLength - 1;

    if (repeat === PlayerRepeat.ONE) {
        // Repeat one: stay on the same track
        return { nextIndex: currentIndex, shouldStop: false };
    } else if (repeat === PlayerRepeat.ALL) {
        // Repeat all: loop to first track if at the end
        if (isLastTrack) {
            return { nextIndex: 0, shouldStop: false };
        } else {
            return { nextIndex: currentIndex + 1, shouldStop: false };
        }
    } else {
        // Repeat none: move to next track, or stop if at the end
        if (isLastTrack) {
            return { nextIndex: currentIndex, shouldStop: true };
        } else {
            return { nextIndex: currentIndex + 1, shouldStop: false };
        }
    }
}

function emitPlayerPlayEvent(
    targetSongUniqueId: string | undefined,
    set: (fn: (state: PlayerState) => void) => void,
    get: () => PlayerState,
): void {
    // If playSongId is provided, find the song and start playback on it
    if (targetSongUniqueId) {
        let playIndex: number | undefined;
        set((state) => {
            const queue = state.getQueue();
            const queueIndex = queue.items.findIndex(
                (item) => item._uniqueId === targetSongUniqueId,
            );

            if (queueIndex !== -1) {
                if (
                    state.player.shuffle === PlayerShuffle.TRACK &&
                    state.queue.shuffled.length > 0
                ) {
                    // Find the shuffled position for this queue index
                    const shuffledPosition = state.queue.shuffled.findIndex(
                        (idx) => idx === queueIndex,
                    );
                    if (shuffledPosition !== -1) {
                        state.player.index = shuffledPosition;
                        playIndex = shuffledPosition;
                    } else {
                        state.player.index = queueIndex;
                        playIndex = queueIndex;
                    }
                } else {
                    state.player.index = queueIndex;
                    playIndex = queueIndex;
                }
                state.player.status = PlayerStatus.PLAYING;
                setTimestampStore(0);
            }
        });

        // Emit PLAYER_PLAY event if playback was started
        if (playIndex !== undefined) {
            eventEmitter.emit('PLAYER_PLAY', {
                id: targetSongUniqueId,
                index: playIndex,
            });
        }
    } else {
        // Otherwise, emit PLAYER_PLAY event for current song if available
        const currentState = get();
        const queue = currentState.getQueue();
        const currentIndex = currentState.player.index;
        const currentSong = queue.items[currentIndex];

        if (currentSong && currentIndex !== undefined && currentIndex >= 0) {
            eventEmitter.emit('PLAYER_PLAY', {
                id: currentSong._uniqueId,
                index: currentIndex,
            });
        }
    }
}

function emitPlayerStop(get: () => PlayerState, reset: boolean): void {
    const currentState = get();
    const queue = currentState.getQueue();
    const currentIndex = currentState.player.index;
    const currentSong = queue.items[currentIndex];

    eventEmitter.emit('PLAYER_STOP', {
        id: currentSong?._uniqueId,
        index: currentIndex !== undefined && currentIndex >= 0 ? currentIndex : undefined,
        reset,
    });
}

// Helper function to find shuffled position for a given queue index
function findShuffledPositionForQueueIndex(
    queueIndex: number,
    shuffled: number[],
): number | undefined {
    const shuffledPosition = shuffled.findIndex((idx) => idx === queueIndex);
    return shuffledPosition !== -1 ? shuffledPosition : undefined;
}

// Helper function to generate shuffled indexes for a queue of given length
function generateShuffledIndexes(length: number): number[] {
    const indexes = Array.from({ length }, (_, i) => i);
    return shuffleInPlace(indexes);
}

// Helper function to regenerate shuffled indexes if shuffle is enabled
function regenerateShuffledIndexesIfNeeded(state: {
    player: { shuffle: PlayerShuffle };
    queue: { default: string[]; shuffled: number[] };
}): void {
    if (isShuffleEnabled(state)) {
        state.queue.shuffled = generateShuffledIndexes(state.queue.default.length);
    }
}

const initialState: State = {
    hydrated: false,
    player: {
        crossfadeDuration: 5,
        crossfadeStyle: CrossfadeStyle.EQUAL_POWER,
        index: -1,
        muted: false,
        pauseOnNextSongEnd: false,
        playerNum: 1,
        repeat: PlayerRepeat.NONE,
        seekToTimestamp: uniqueSeekToTimestamp(0),
        shuffle: PlayerShuffle.NONE,
        speed: 1,
        status: PlayerStatus.PAUSED,
        transitionType: PlayerStyle.GAPLESS,
        volume: 30,
    },
    queue: {
        default: [],
        shuffled: [],
        songs: {},
    },
};

export const usePlayerStoreBase = createWithEqualityFn<PlayerState>()(
    persist(
        subscribeWithSelector(
            immer((set, get) => ({
                addToQueueByType: (items, playType, playSongId) => {
                    // Perf: marks a play/enqueue so the logs anchor the
                    // subsequent query + render activity to a play-start.
                    perfLog('play:enqueue', { count: items.length, playType });
                    const newItems = items.map(toQueueSong);
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    // Find the target song's uniqueId if playSongId is provided
                    const targetSongUniqueId = playSongId
                        ? newItems.find((item) => item.id === playSongId)?._uniqueId
                        : undefined;

                    switch (playType) {
                        case Play.LAST: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                const oldQueueLength = state.queue.default.length;
                                state.queue.default = [...state.queue.default, ...newUniqueIds];

                                if (isShuffleEnabled(state)) {
                                    // New items will be at indexes starting from oldQueueLength
                                    const newIndexes = Array.from(
                                        { length: newUniqueIds.length },
                                        (_, i) => oldQueueLength + i,
                                    );
                                    // Shuffle the new indexes and add to the end of shuffled array
                                    const shuffledNewIndexes = shuffleInPlace([...newIndexes]);
                                    state.queue.shuffled = [
                                        ...state.queue.shuffled,
                                        ...shuffledNewIndexes,
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.LAST_SHUFFLE: {
                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffle the new items before appending
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);

                                const oldQueueLength = state.queue.default.length;
                                state.queue.default = [...state.queue.default, ...shuffledIds];

                                if (state.player.shuffle === PlayerShuffle.TRACK) {
                                    // New items will be at indexes starting from oldQueueLength
                                    const newIndexes = Array.from(
                                        { length: shuffledIds.length },
                                        (_, i) => oldQueueLength + i,
                                    );
                                    // Shuffle the new indexes and add to the end of shuffled array
                                    const shuffledNewIndexes = shuffleInPlace([...newIndexes]);
                                    state.queue.shuffled = [
                                        ...state.queue.shuffled,
                                        ...shuffledNewIndexes,
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.NEXT: {
                            set((state) => {
                                const currentShuffledIndex = state.player.index;
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // When shuffle is on but nothing is playing yet
                                // (index -1), shuffled[-1] is undefined → +1 = NaN
                                // → slice(0, NaN) silently drops the queue prefix.
                                // Fall back to the front (matches the non-shuffle
                                // -1 → 0 behaviour).
                                const insertPosition =
                                    state.player.shuffle === PlayerShuffle.TRACK
                                        ? (state.queue.shuffled[currentShuffledIndex] ?? -1) + 1
                                        : currentShuffledIndex + 1;

                                state.queue.default = [
                                    ...state.queue.default.slice(0, insertPosition),
                                    ...newUniqueIds,
                                    ...state.queue.default.slice(insertPosition),
                                ];

                                if (isShuffleEnabled(state)) {
                                    // Adjust existing indexes that are >= insertPosition
                                    const adjustedShuffled = adjustShuffledIndexesForInsertion(
                                        state.queue.shuffled,
                                        insertPosition,
                                        newUniqueIds.length,
                                    );

                                    // New items will be at indexes starting from insertPosition
                                    const newIndexes = Array.from(
                                        { length: newUniqueIds.length },
                                        (_, i) => insertPosition + i,
                                    );

                                    // Shuffle the new indexes and add directly after current shuffled index
                                    const shuffledNewIndexes = shuffleInPlace([...newIndexes]);
                                    state.queue.shuffled = [
                                        ...adjustedShuffled.slice(0, currentShuffledIndex + 1),
                                        ...shuffledNewIndexes,
                                        ...adjustedShuffled.slice(currentShuffledIndex + 1),
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.NEXT_SHUFFLE: {
                            set((state) => {
                                const currentShuffledIndex = state.player.index;
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffle the new items before inserting
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);

                                // Guard the nothing-playing-under-shuffle case
                                // (index -1 → shuffled[-1] undefined → NaN, which
                                // would drop the queue prefix). Fall back to front.
                                const insertPosition = isShuffleEnabled(state)
                                    ? (state.queue.shuffled[currentShuffledIndex] ?? -1) + 1
                                    : currentShuffledIndex + 1;

                                state.queue.default = [
                                    ...state.queue.default.slice(0, insertPosition),
                                    ...shuffledIds,
                                    ...state.queue.default.slice(insertPosition),
                                ];

                                if (isShuffleEnabled(state)) {
                                    // Adjust existing indexes that are >= insertPosition
                                    const adjustedShuffled = adjustShuffledIndexesForInsertion(
                                        state.queue.shuffled,
                                        insertPosition,
                                        shuffledIds.length,
                                    );

                                    // New items will be at indexes starting from insertPosition
                                    const newIndexes = Array.from(
                                        { length: shuffledIds.length },
                                        (_, i) => insertPosition + i,
                                    );

                                    // Shuffle the new indexes and add directly after current shuffled index
                                    const shuffledNewIndexes = shuffleInPlace([...newIndexes]);
                                    state.queue.shuffled = [
                                        ...adjustedShuffled.slice(0, currentShuffledIndex + 1),
                                        ...shuffledNewIndexes,
                                        ...adjustedShuffled.slice(currentShuffledIndex + 1),
                                    ];
                                }
                            });
                            break;
                        }
                        case Play.NOW: {
                            if (useRadioPlayerStore.getState().currentStreamUrl) {
                                useRadioPlayerStore.getState().actions.stop();
                            }

                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                state.queue.default = [];
                                state.player.index = 0;
                                state.player.status = PlayerStatus.PLAYING;
                                state.player.playerNum = 1;
                                setTimestampStore(0);
                                state.queue.default = newUniqueIds;

                                if (state.player.shuffle === PlayerShuffle.TRACK) {
                                    // If targetSongUniqueId is provided, ensure it's at position 0 in shuffled array
                                    if (targetSongUniqueId) {
                                        const initialIndex = newUniqueIds.findIndex(
                                            (id) => id === targetSongUniqueId,
                                        );
                                        if (initialIndex !== -1) {
                                            const allIndexes = Array.from(
                                                { length: newUniqueIds.length },
                                                (_, i) => i,
                                            );

                                            const remainingIndexes = allIndexes.filter(
                                                (idx) => idx !== initialIndex,
                                            );

                                            const shuffledRemaining = shuffleInPlace([
                                                ...remainingIndexes,
                                            ]);

                                            state.queue.shuffled = [
                                                initialIndex,
                                                ...shuffledRemaining,
                                            ];
                                        } else {
                                            // Fallback: if initial song not found, generate normally
                                            state.queue.shuffled = generateShuffledIndexes(
                                                newUniqueIds.length,
                                            );
                                        }
                                    } else {
                                        state.queue.shuffled = generateShuffledIndexes(
                                            newUniqueIds.length,
                                        );
                                    }
                                }
                            });

                            emitPlayerPlayEvent(targetSongUniqueId, set, get);
                            break;
                        }
                        case Play.SHUFFLE: {
                            if (useRadioPlayerStore.getState().currentStreamUrl) {
                                useRadioPlayerStore.getState().actions.stop();
                            }

                            set((state) => {
                                newItems.forEach((item) => {
                                    state.queue.songs[item._uniqueId] = item;
                                });

                                // Shuffle the new items before adding to queue
                                const shuffledIds = shuffleInPlace([...newUniqueIds]);

                                state.queue.default = [];
                                state.player.index = 0;
                                state.player.status = PlayerStatus.PLAYING;
                                state.player.playerNum = 1;
                                setTimestampStore(0);
                                state.queue.default = shuffledIds;

                                // Always maintain shuffled array when using Play.SHUFFLE
                                state.queue.shuffled = generateShuffledIndexes(shuffledIds.length);
                            });

                            emitPlayerPlayEvent(targetSongUniqueId, set, get);
                            break;
                        }
                    }
                },
                addToQueueByUniqueId: (items, uniqueId, edge, playSongId) => {
                    const newItems = items.map(toQueueSong);
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    // Find the target song's uniqueId if playSongId is provided
                    const targetSongUniqueId = playSongId
                        ? newItems.find((item) => item.id === playSongId)?._uniqueId
                        : undefined;

                    set((state) => {
                        // Add new songs to songs object
                        newItems.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const index = state.queue.default.findIndex((id) => id === uniqueId);

                        const insertIndex = Math.max(0, edge === 'top' ? index : index + 1);

                        const newQueue = [
                            ...state.queue.default.slice(0, insertIndex),
                            ...newUniqueIds,
                            ...state.queue.default.slice(insertIndex),
                        ];

                        state.queue.default = newQueue;

                        if (state.player.shuffle === PlayerShuffle.TRACK) {
                            const currentTrack = state.getCurrentSong() as QueueSong | undefined;
                            const currentTrackUniqueId = currentTrack?._uniqueId;

                            if (currentTrackUniqueId) {
                                // Adjust existing shuffled indexes that are >= insertIndex
                                const adjustedShuffled = state.queue.shuffled.map((idx) => {
                                    if (idx >= insertIndex) {
                                        return idx + newUniqueIds.length;
                                    }
                                    return idx;
                                });

                                // New items will be at indexes starting from insertIndex
                                const newIndexes = Array.from(
                                    { length: newUniqueIds.length },
                                    (_, i) => insertIndex + i,
                                );

                                const currentShuffledIndex = state.player.index;
                                state.queue.shuffled = addIndexesToShuffled(
                                    adjustedShuffled,
                                    currentShuffledIndex,
                                    newIndexes,
                                );

                                // Recalculate player index to the shuffled position
                                const queueIndex = newQueue.findIndex(
                                    (id) => id === currentTrackUniqueId,
                                );
                                if (queueIndex !== -1) {
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                    }
                                }
                            } else {
                                // No current track, regenerate shuffled indexes
                                state.queue.shuffled = generateShuffledIndexes(newQueue.length);
                            }
                        } else {
                            // Recalculate the player index if we're inserting items above the current index
                            if (insertIndex <= state.player.index) {
                                state.player.index = state.player.index + newUniqueIds.length;
                            }

                            recalculatePlayerIndex(state, newQueue);
                        }
                    });

                    // If playSongId is provided, find the song and start playback on it
                    if (targetSongUniqueId) {
                        let playIndex: number | undefined;
                        set((state) => {
                            const queue = state.getQueue();
                            const queueIndex = queue.items.findIndex(
                                (item) => item._uniqueId === targetSongUniqueId,
                            );

                            if (queueIndex !== -1) {
                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.shuffled.length > 0
                                ) {
                                    // Find the shuffled position for this queue index
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                        playIndex = shuffledPosition;
                                    } else {
                                        state.player.index = queueIndex;
                                        playIndex = queueIndex;
                                    }
                                } else {
                                    state.player.index = queueIndex;
                                    playIndex = queueIndex;
                                }
                                state.player.status = PlayerStatus.PLAYING;
                                setTimestampStore(0);
                            }
                        });

                        // Emit PLAYER_PLAY event if playback was started
                        if (playIndex !== undefined) {
                            eventEmitter.emit('PLAYER_PLAY', {
                                id: targetSongUniqueId,
                                index: playIndex,
                            });
                        }
                    }
                },
                clearQueue: () => {
                    set((state) => {
                        state.player.index = -1;
                        state.queue.default = [];
                        state.queue.shuffled = [];
                        state.queue.songs = {};
                    });
                },
                clearSelected: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = new Set(items.map((item) => item._uniqueId));

                        const indexesToRemove = new Set<number>();

                        state.queue.default.forEach((id, index) => {
                            if (uniqueIds.has(id)) {
                                indexesToRemove.add(index);
                            }
                        });

                        state.queue.default = state.queue.default.filter(
                            (id) => !uniqueIds.has(id),
                        );

                        if (isShuffleEnabled(state)) {
                            // Remove indexes from shuffled array and adjust remaining indexes
                            const newShuffled = state.queue.shuffled
                                .filter((idx) => !indexesToRemove.has(idx))
                                .map((idx) => {
                                    // Count how many removed indexes are before this index
                                    let adjustment = 0;
                                    for (const removedIdx of indexesToRemove) {
                                        if (removedIdx < idx) {
                                            adjustment++;
                                        }
                                    }
                                    return idx - adjustment;
                                });
                            state.queue.shuffled = newShuffled;
                        } else {
                            state.queue.shuffled = [];
                        }

                        cleanupOrphanedSongs(state);

                        recalculatePlayerIndex(state, state.queue.default);
                    });
                },
                decreaseVolume: (value: number) => {
                    set((state) => {
                        state.player.volume = Math.max(0, state.player.volume - value);
                    });
                },
                getCurrentSong: () => {
                    // Hot path: called by `usePlayerSong` on every store mutation for
                    // every subscriber. Avoid `state.getQueue()` here — it would build a
                    // full QueueSong[] copy of the default-order queue, allocating a new
                    // array proportional to queue length on every call. Direct O(1) lookup
                    // via the songs map keeps mutation-time cost flat regardless of queue
                    // size.
                    const state = get();
                    let index = state.player.index;

                    // If shuffle is enabled, map shuffled position to actual queue position
                    if (isShuffleEnabled(state)) {
                        index = mapShuffledToQueueIndex(index, state.queue.shuffled);
                    }

                    const uniqueId = state.queue.default[index];
                    if (!uniqueId) {
                        return undefined;
                    }
                    return state.queue.songs[uniqueId];
                },
                getPlayerData: () => {
                    const state = get();
                    const queue = state.getQueue();
                    const index = state.player.index;

                    // If shuffle is enabled, map shuffled position to actual queue position for display
                    let queueIndex = index;
                    if (isShuffleEnabled(state)) {
                        queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
                    }

                    const currentSong = queue.items[queueIndex];
                    const repeat = state.player.repeat;

                    // For previousSong calculation, we need to consider the shuffled order
                    let previousSong: QueueSong | undefined;
                    if (isShuffleEnabled(state)) {
                        // Calculate previous in shuffled order
                        const previousShuffledIndex = index - 1;
                        if (previousShuffledIndex >= 0) {
                            const previousQueueIndex = state.queue.shuffled[previousShuffledIndex];
                            previousSong = queue.items[previousQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            // Wrap to last in shuffled order
                            const lastShuffledIndex = state.queue.shuffled.length - 1;
                            const lastQueueIndex = state.queue.shuffled[lastShuffledIndex];
                            previousSong = queue.items[lastQueueIndex];
                        }
                    } else {
                        previousSong = queueIndex > 0 ? queue.items[queueIndex - 1] : undefined;
                    }

                    // For nextSong calculation, we need to consider the shuffled order
                    let nextSong: QueueSong | undefined;
                    if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                        // Calculate next in shuffled order
                        const nextShuffledIndex = index + 1;
                        if (nextShuffledIndex < state.queue.shuffled.length) {
                            const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                            nextSong = queue.items[nextQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            // Wrap to first in shuffled order
                            const firstQueueIndex = state.queue.shuffled[0];
                            nextSong = queue.items[firstQueueIndex];
                        }
                    } else {
                        nextSong = calculateNextSong(queueIndex, queue.items, repeat);
                    }

                    const { player1, player2 } = getDualPlayerSongs(
                        state.player.playerNum,
                        currentSong,
                        nextSong,
                        repeat,
                    );

                    return {
                        currentSong,
                        index: queueIndex, // Return the actual queue position for display
                        nextSong,
                        num: state.player.playerNum,
                        player1,
                        player2,
                        previousSong,
                        queueLength: state.queue.default.length,
                        status: state.player.status,
                    };
                },
                getQueue: (groupBy?: QueueGroupingProperty) => {
                    const queue = get().getQueueOrder();

                    if (!groupBy) {
                        return queue;
                    }

                    // Track groups in order of appearance
                    const groups: { count: number; name: string }[] = [];
                    const seenGroups = new Set<string>();

                    // Process items and build groups in order
                    queue.items.forEach((item) => {
                        const groupValue = String(item[groupBy] || 'Unknown');

                        if (!seenGroups.has(groupValue)) {
                            seenGroups.add(groupValue);
                            groups.push({ count: 1, name: groupValue });
                        } else {
                            // Find the last occurrence of this group value
                            const lastIndex = [...groups]
                                .reverse()
                                .findIndex((g) => g.name === groupValue);
                            if (lastIndex === -1) return;

                            // If the previous group is different, create a new group
                            const previousGroup = groups[groups.length - 1];
                            if (previousGroup.name !== groupValue) {
                                groups.push({ count: 1, name: groupValue });
                            } else {
                                // Increment the count of the last matching group
                                groups[groups.length - 1].count++;
                            }
                        }
                    });

                    return { groups, items: queue.items };
                },
                getQueueOrder: () => {
                    const state = get();
                    const songs = state.queue.songs;
                    const defaultIds = state.queue.default;
                    const defaultQueue: QueueSong[] = [];

                    for (const id of defaultIds) {
                        const song = songs[id];
                        if (song) defaultQueue.push(song);
                    }

                    // Always return original order (shuffle only affects playback, not display)
                    return {
                        groups: [{ count: defaultQueue.length, name: 'All' }],
                        items: defaultQueue,
                    };
                },
                getVisibleQueue: () => {
                    const state = get();
                    const showInPlaybackOrder =
                        useSettingsStore.getState().general.queueInPlaybackOrder;

                    if (!showInPlaybackOrder || !isShuffleEnabled(state)) {
                        return state.getQueue();
                    }

                    // Render items in shuffle order: each entry of state.queue.shuffled is
                    // an index into state.queue.default. Look up each via state.queue.songs.
                    const songs = state.queue.songs;
                    const defaultIds = state.queue.default;
                    const items: QueueSong[] = [];
                    for (const idx of state.queue.shuffled) {
                        const id = defaultIds[idx];
                        const song = id ? songs[id] : undefined;
                        if (song) items.push(song);
                    }

                    return {
                        groups: [{ count: items.length, name: 'All' }],
                        items,
                    };
                },
                increaseVolume: (value: number) => {
                    set((state) => {
                        state.player.volume = Math.min(100, state.player.volume + value);
                    });
                },
                isFirstTrackInQueue: () => {
                    const state = get();
                    const currentIndex = state.player.index;
                    return currentIndex === 0;
                },
                isLastTrackInQueue: () => {
                    const state = get();
                    const queue = state.getQueueOrder();
                    const currentIndex = state.player.index;
                    return currentIndex === queue.items.length - 1;
                },
                mediaAutoNext: () => {
                    const stateSnapshot = get();
                    const currentIndex = stateSnapshot.player.index;
                    const player = stateSnapshot.player;
                    const repeat = player.repeat;
                    const queue = stateSnapshot.getQueueOrder();
                    const isShuffle = isShuffleEnabled(stateSnapshot);

                    const playbackLength = isShuffle
                        ? stateSnapshot.queue.shuffled.length
                        : queue.items.length;

                    const { nextIndex: nextPlaybackIndex, shouldStop } = calculateNextIndex(
                        currentIndex,
                        playbackLength,
                        repeat,
                    );

                    const isRepeatOneSameTrack =
                        repeat === PlayerRepeat.ONE && nextPlaybackIndex === currentIndex;
                    // Dual web players alternate for gapless/crossfade between tracks. Repeat-one
                    // replays the same track — keep playerNum so Chromium stays bound to the same
                    // <audio> element and hardware media keys keep working.
                    const newPlayerNum = isRepeatOneSameTrack
                        ? player.playerNum
                        : player.playerNum === 1
                          ? 2
                          : 1;
                    const pauseOnNext = player.pauseOnNextSongEnd;
                    const newStatus = shouldStop
                        ? PlayerStatus.STOPPED
                        : pauseOnNext
                          ? PlayerStatus.PAUSED
                          : PlayerStatus.PLAYING;
                    const shouldKeepCurrentPlayer = newStatus !== PlayerStatus.PLAYING;
                    const shouldSwapPlayer = !isRepeatOneSameTrack && !shouldKeepCurrentPlayer;

                    set((state) => {
                        state.player.index = nextPlaybackIndex;
                        state.player.playerNum = shouldSwapPlayer ? newPlayerNum : player.playerNum;
                        setTimestampStore(0);
                        state.player.status = newStatus;

                        if (shouldStop) {
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        }

                        if (pauseOnNext) {
                            state.player.pauseOnNextSongEnd = false;
                        }
                    });

                    if (shouldStop) {
                        emitPlayerStop(get, true);
                    }

                    if (repeat === PlayerRepeat.ONE && nextPlaybackIndex === currentIndex) {
                        eventEmitter.emit('PLAYER_REPEATED', {
                            index: nextPlaybackIndex,
                        });
                    }

                    // Compute current/next/previous using the same shuffle-aware mapping as getPlayerData().
                    let currentQueueIndex = nextPlaybackIndex;
                    if (isShuffle) {
                        currentQueueIndex = mapShuffledToQueueIndex(
                            nextPlaybackIndex,
                            stateSnapshot.queue.shuffled,
                        );
                    }

                    const currentSong = queue.items[currentQueueIndex];

                    let nextSong: QueueSong | undefined;
                    if (isShuffle && repeat !== PlayerRepeat.ONE) {
                        const nextShuffledIndex = nextPlaybackIndex + 1;
                        if (nextShuffledIndex < stateSnapshot.queue.shuffled.length) {
                            const nextQueueIndex = stateSnapshot.queue.shuffled[nextShuffledIndex];
                            nextSong = queue.items[nextQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            const firstQueueIndex = stateSnapshot.queue.shuffled[0];
                            nextSong = queue.items[firstQueueIndex];
                        }
                    } else {
                        nextSong = calculateNextSong(currentQueueIndex, queue.items, repeat);
                    }

                    let previousSong: QueueSong | undefined;
                    if (isShuffle) {
                        const prevShuffledIndex = nextPlaybackIndex - 1;
                        if (prevShuffledIndex >= 0) {
                            const prevQueueIndex = stateSnapshot.queue.shuffled[prevShuffledIndex];
                            previousSong = queue.items[prevQueueIndex];
                        } else if (repeat === PlayerRepeat.ALL) {
                            const lastShuffledIndex = stateSnapshot.queue.shuffled.length - 1;
                            const lastQueueIndex = stateSnapshot.queue.shuffled[lastShuffledIndex];
                            previousSong = queue.items[lastQueueIndex];
                        }
                    } else {
                        previousSong =
                            currentQueueIndex > 0 ? queue.items[currentQueueIndex - 1] : undefined;
                    }

                    const { player1, player2 } = getDualPlayerSongs(
                        shouldSwapPlayer ? newPlayerNum : player.playerNum,
                        currentSong,
                        nextSong,
                        repeat,
                    );

                    return {
                        currentSong,
                        index: currentQueueIndex,
                        nextSong,
                        num: shouldSwapPlayer ? newPlayerNum : player.playerNum,
                        player1,
                        player2,
                        previousSong,
                        queueLength: queue.items.length,
                        status: newStatus,
                    };
                },
                mediaNext: () => {
                    const state = get();
                    const currentIndex = state.player.index;
                    const player = state.player;
                    const repeat = player.repeat;
                    const isShuffle = isShuffleEnabled(state);
                    const queue = state.getQueueOrder();
                    const playbackLength = isShuffle
                        ? state.queue.shuffled.length
                        : queue.items.length;

                    if (repeat === PlayerRepeat.ONE) {
                        // Manual next while repeat-one is active should still advance in the queue.
                        const nextIndex = Math.min(playbackLength - 1, currentIndex + 1);

                        set((state) => {
                            state.player.index = nextIndex;
                            state.player.playerNum = 1;
                            setTimestampStore(0);
                        });

                        eventEmitter.emit('MEDIA_NEXT', {
                            currentIndex,
                            nextIndex,
                        });
                        return;
                    }

                    const { nextIndex, shouldStop } = calculateNextIndex(
                        currentIndex,
                        playbackLength,
                        repeat,
                    );

                    if (shouldStop) {
                        set((state) => {
                            state.player.status = PlayerStatus.STOPPED;
                            state.player.playerNum = 1;
                            setTimestampStore(0);
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        });
                        emitPlayerStop(get, true);
                        return;
                    }

                    set((state) => {
                        state.player.index = nextIndex;
                        state.player.playerNum = 1;
                        setTimestampStore(0);
                    });

                    eventEmitter.emit('MEDIA_NEXT', {
                        currentIndex,
                        nextIndex,
                    });
                },
                mediaPause: () => {
                    set((state) => {
                        state.player.status = PlayerStatus.PAUSED;
                    });
                },
                mediaPlay: (id?: string) => {
                    let playIndex: number | undefined;

                    set((state) => {
                        if (id) {
                            const queue = state.getQueue();

                            // Find the song in the original queue
                            const queueIndex = queue.items.findIndex(
                                (item) => item._uniqueId === id,
                            );

                            if (queueIndex !== -1) {
                                if (
                                    state.player.shuffle === PlayerShuffle.TRACK &&
                                    state.queue.shuffled.length > 0
                                ) {
                                    // Find the shuffled position for this queue index
                                    const shuffledPosition = state.queue.shuffled.findIndex(
                                        (idx) => idx === queueIndex,
                                    );
                                    if (shuffledPosition !== -1) {
                                        state.player.index = shuffledPosition;
                                        playIndex = shuffledPosition;
                                    } else {
                                        state.player.index = queueIndex;
                                        playIndex = queueIndex;
                                    }
                                } else {
                                    state.player.index = queueIndex;
                                    playIndex = queueIndex;
                                }
                                setTimestampStore(0);
                            }
                        }

                        state.player.status = PlayerStatus.PLAYING;
                    });

                    if (id && playIndex !== undefined) {
                        eventEmitter.emit('PLAYER_PLAY', {
                            id,
                            index: playIndex,
                        });
                    }
                },
                mediaPlayByIndex: (index: number) => {
                    let playIndex: number | undefined;
                    let songId: string | undefined;

                    set((state) => {
                        const queue = state.getQueue();

                        if (index === -1 || index >= queue.items.length) {
                            state.player.status = PlayerStatus.PAUSED;
                            return;
                        }

                        // Get the song's unique ID from the queue
                        const song = queue.items[index];
                        if (song) {
                            songId = song._uniqueId;
                        }

                        // index is the position in the original queue
                        if (isShuffleEnabled(state)) {
                            // Find the shuffled position for this queue index
                            const shuffledPosition = findShuffledPositionForQueueIndex(
                                index,
                                state.queue.shuffled,
                            );
                            playIndex = shuffledPosition !== undefined ? shuffledPosition : index;
                            state.player.index = playIndex;
                        } else {
                            playIndex = index;
                            state.player.index = index;
                        }
                        setTimestampStore(0);

                        state.player.status = PlayerStatus.PLAYING;
                    });

                    if (songId && playIndex !== undefined) {
                        eventEmitter.emit('PLAYER_PLAY', {
                            id: songId,
                            index: playIndex,
                        });
                    }
                },
                mediaPrevious: () => {
                    const currentIndex = get().player.index;
                    const player = get().player;
                    const queue = get().getQueueOrder();
                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const isFirstTrack = currentIndex === 0;

                    // If timestamp is greater than 10 seconds, restart current song
                    if (currentTimestamp > 10) {
                        set((state) => {
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        });
                        return;
                    }

                    let previousIndex: number;

                    if (player.repeat === PlayerRepeat.ALL && isFirstTrack) {
                        // Repeat all: wrap to last track when on first track
                        previousIndex = queue.items.length - 1;
                    } else if (player.repeat === PlayerRepeat.NONE && isFirstTrack) {
                        // Repeat none: stay on first track if already there
                        previousIndex = currentIndex;
                    } else {
                        // Otherwise, go to previous track
                        previousIndex = Math.max(0, currentIndex - 1);
                    }

                    set((state) => {
                        state.player.index = previousIndex;
                        state.player.playerNum = 1;
                        setTimestampStore(0);
                    });

                    eventEmitter.emit('MEDIA_PREV', {
                        currentIndex,
                        prevIndex: previousIndex,
                    });
                },
                mediaSeekToTimestamp: (timestamp: number) => {
                    // See mediaSkipBackward: update the timestamp store right away to
                    // avoid the stale-read left by the ~500ms engine poll.
                    setTimestampStore(timestamp);
                    set((state) => {
                        state.player.seekToTimestamp = uniqueSeekToTimestamp(timestamp);
                    });
                },
                mediaSkipBackward: (offset?: number) => {
                    const offsetFromSettings =
                        useSettingsStore.getState().general.skipButtons.skipBackwardSeconds;
                    const timeToSkip = offset ?? offsetFromSettings ?? 5;
                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    const newTimestamp = Math.max(0, currentTimestamp - timeToSkip);

                    // Update the timestamp store right away so the UI and any
                    // subsequent seek compute from the new position instead of the
                    // stale value left by the ~500ms engine poll (otherwise mashing
                    // the seek keys repeatedly lands on the same time).
                    setTimestampStore(newTimestamp);
                    set((state) => {
                        state.player.seekToTimestamp = uniqueSeekToTimestamp(newTimestamp);
                    });
                },
                mediaSkipForward: (offset?: number) => {
                    const state = get();
                    const queue = state.getQueue();
                    const index = state.player.index;
                    const currentTrack = queue.items[index];
                    const duration = currentTrack?.duration;
                    const offsetFromSettings =
                        useSettingsStore.getState().general.skipButtons.skipForwardSeconds;
                    const timeToSkip = offset ?? offsetFromSettings ?? 5;

                    const currentTimestamp = useTimestampStoreBase.getState().timestamp;
                    // When the duration is known, clamp just shy of the end.
                    // Otherwise (radio / streams / metadata not loaded yet)
                    // advance without an upper bound instead of no-op'ing — the
                    // engine clamps an over-seek itself, and a silent dead button
                    // is worse. mediaSkipBackward already ignores duration.
                    const newTimestamp = duration
                        ? Math.min(duration - 1, currentTimestamp + timeToSkip)
                        : currentTimestamp + timeToSkip;

                    // See mediaSkipBackward: update the timestamp store right away to
                    // avoid the stale-read left by the ~500ms engine poll.
                    setTimestampStore(newTimestamp);
                    set((state) => {
                        state.player.seekToTimestamp = uniqueSeekToTimestamp(newTimestamp);
                    });
                },
                mediaStop: (options?: { reset?: boolean }) => {
                    const reset = options?.reset !== false;
                    set((state) => {
                        state.player.status = PlayerStatus.STOPPED;
                        setTimestampStore(0);
                        if (reset) {
                            state.player.seekToTimestamp = uniqueSeekToTimestamp(0);
                        }
                    });

                    emitPlayerStop(get, reset);
                },
                mediaToggleMute: () => {
                    set((state) => {
                        state.player.muted = !state.player.muted;
                    });
                },
                mediaTogglePlayPause: () => {
                    set((state) => {
                        if (state.player.status === PlayerStatus.PLAYING) {
                            state.player.status = PlayerStatus.PAUSED;
                        } else {
                            state.player.status = PlayerStatus.PLAYING;
                        }
                    });
                },
                moveSelectedTo: (
                    items: QueueSong[],
                    uniqueId: string,
                    edge: 'bottom' | 'top',
                    // 'visible' (UI drag): reorder whichever order the queue
                    // table currently renders. 'default' (peer-sync wire,
                    // SEV-3): always reorder the default order — remote
                    // indices are exchanged in default-order space no matter
                    // how this device displays its queue.
                    space: 'default' | 'visible' = 'visible',
                ) => {
                    const itemUniqueIds = items.map((item) => item._uniqueId);

                    set((state) => {
                        const existingIds = new Set(Object.keys(state.queue.songs));

                        // Add new songs to songs object (avoiding duplicates)
                        items.forEach((item) => {
                            if (!existingIds.has(item._uniqueId)) {
                                state.queue.songs[item._uniqueId] = item;
                            }
                        });

                        const draggingShuffledView =
                            space === 'visible' &&
                            isShuffleEnabled(state) &&
                            useSettingsStore.getState().general.queueInPlaybackOrder;

                        if (draggingShuffledView) {
                            // The queue renders in playback (shuffled) order, so the
                            // drag reorders queue.shuffled; the default order stays
                            // untouched. Brand-new songs are appended to the default
                            // order first so shuffled[] has an index to point at.
                            itemUniqueIds.forEach((id) => {
                                if (!state.queue.default.includes(id)) {
                                    state.queue.default.push(id);
                                }
                            });

                            const defaultIndexById = new Map<string, number>();
                            state.queue.default.forEach((id, idx) => defaultIndexById.set(id, idx));

                            const movedIndexes = itemUniqueIds
                                .map((id) => defaultIndexById.get(id))
                                .filter((idx): idx is number => idx !== undefined);
                            const movedSet = new Set(movedIndexes);

                            const targetIndex = defaultIndexById.get(uniqueId);
                            const without = state.queue.shuffled.filter(
                                (idx) => !movedSet.has(idx),
                            );

                            const targetPosition =
                                targetIndex === undefined
                                    ? -1
                                    : without.findIndex((idx) => idx === targetIndex);
                            let insertPosition: number;
                            if (targetPosition === -1) {
                                insertPosition = edge === 'top' ? 0 : without.length;
                            } else {
                                insertPosition =
                                    edge === 'top' ? targetPosition : targetPosition + 1;
                            }

                            state.queue.shuffled = [
                                ...without.slice(0, insertPosition),
                                ...movedIndexes,
                                ...without.slice(insertPosition),
                            ];

                            recalculatePlayerIndex(state, state.queue.default);
                            return;
                        }

                        const oldDefault = [...state.queue.default];

                        // Find the index of the drop target
                        const index = state.queue.default.findIndex((id) => id === uniqueId);

                        // Get the new index based on the edge
                        const insertIndex = Math.max(0, edge === 'top' ? index : index + 1);

                        const idsBefore = state.queue.default
                            .slice(0, insertIndex)
                            .filter((id) => !itemUniqueIds.includes(id));

                        const idsAfter = state.queue.default
                            .slice(insertIndex)
                            .filter((id) => !itemUniqueIds.includes(id));

                        const newQueue = [...idsBefore, ...itemUniqueIds, ...idsAfter];

                        remapShuffledAfterReorder(state, oldDefault, newQueue);
                        state.queue.default = newQueue;
                        recalculatePlayerIndex(state, newQueue);
                    });
                },
                moveSelectedToBottom: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const oldDefault = [...state.queue.default];
                        const filtered = oldDefault.filter((id) => !uniqueIds.includes(id));

                        const newQueue = [...filtered, ...uniqueIds];

                        remapShuffledAfterReorder(state, oldDefault, newQueue);
                        state.queue.default = newQueue;
                        recalculatePlayerIndex(state, newQueue);
                    });
                },
                moveSelectedToNext: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const oldDefault = [...state.queue.default];
                        const shuffleOn = isShuffleEnabled(state);
                        const currentTrack = state.getCurrentSong() as QueueSong | undefined;

                        // The insert position is the current song's DEFAULT-order
                        // index; under shuffle `player.index` is a shuffled position,
                        // so resolve through the current track instead.
                        const currentIndex = currentTrack
                            ? oldDefault.findIndex((id) => id === currentTrack._uniqueId)
                            : state.player.index;

                        let beforeCurrent = 0;
                        const filtered = oldDefault.filter((id, idx) => {
                            const shouldMove = uniqueIds.includes(id);
                            if (shouldMove && idx < currentIndex) {
                                beforeCurrent++;
                            }

                            return !shouldMove;
                        });

                        // For every item that is before the current item, subtract one as
                        // these items will shift the queue up
                        const insertIndex = Math.max(0, currentIndex + 1 - beforeCurrent);

                        const newQueue = [
                            ...filtered.slice(0, insertIndex),
                            ...uniqueIds,
                            ...filtered.slice(insertIndex),
                        ];

                        if (shuffleOn) {
                            remapShuffledAfterReorder(state, oldDefault, newQueue);

                            // "Play next" must also hold in playback order: pull the
                            // moved entries out of queue.shuffled and reinsert them
                            // right after the current track, in selection order.
                            const newIndexById = new Map<string, number>();
                            newQueue.forEach((id, idx) => newIndexById.set(id, idx));

                            const movedIndexes = uniqueIds
                                .map((id) => newIndexById.get(id))
                                .filter((idx): idx is number => idx !== undefined);
                            const movedSet = new Set(movedIndexes);
                            const without = state.queue.shuffled.filter(
                                (idx) => !movedSet.has(idx),
                            );

                            const currentNewIndex = currentTrack
                                ? newIndexById.get(currentTrack._uniqueId)
                                : undefined;
                            const currentPosition =
                                currentNewIndex === undefined
                                    ? -1
                                    : without.findIndex((idx) => idx === currentNewIndex);

                            state.queue.shuffled = [
                                ...without.slice(0, currentPosition + 1),
                                ...movedIndexes,
                                ...without.slice(currentPosition + 1),
                            ];
                        }

                        state.queue.default = newQueue;
                        recalculatePlayerIndex(state, newQueue);
                    });
                },
                moveSelectedToTop: (items: QueueSong[]) => {
                    set((state) => {
                        const uniqueIds = items.map((item) => item._uniqueId);

                        // Add new songs to songs object
                        items.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        const oldDefault = [...state.queue.default];
                        const filtered = oldDefault.filter((id) => !uniqueIds.includes(id));

                        const newQueue = [...uniqueIds, ...filtered];

                        remapShuffledAfterReorder(state, oldDefault, newQueue);
                        state.queue.default = newQueue;
                        recalculatePlayerIndex(state, newQueue);
                    });
                },
                setQueue: (items, index, position) => {
                    const newItems = items.map(toQueueSong);
                    const newUniqueIds = newItems.map((item) => item._uniqueId);

                    set((state) => {
                        newItems.forEach((item) => {
                            state.queue.songs[item._uniqueId] = item;
                        });

                        state.player.index = index ?? 0;
                        state.player.status = PlayerStatus.PLAYING;
                        state.player.playerNum = 1;
                        state.queue.default = newUniqueIds;
                    });

                    eventEmitter.emit('QUEUE_RESTORED', {
                        data: items,
                        index: index ?? 0,
                        position: position ?? 0,
                    });
                },
                ...initialState,
                setCrossfadeDuration: (duration: number) => {
                    set((state) => {
                        const normalizedDuration = Math.max(0, Math.min(10, duration));
                        state.player.crossfadeDuration = normalizedDuration;
                    });
                },
                setCrossfadeStyle: (style: CrossfadeStyle) => {
                    set((state) => {
                        state.player.crossfadeStyle = style;
                    });
                },
                setPauseOnNextSongEnd: (value: boolean) => {
                    set((state) => {
                        state.player.pauseOnNextSongEnd = value;
                    });
                },
                setRepeat: (repeat: PlayerRepeat) => {
                    set((state) => {
                        state.player.repeat = repeat;
                    });
                },
                setShuffle: (shuffle: PlayerShuffle) => {
                    set((state) => {
                        const wasShuffled = state.player.shuffle === PlayerShuffle.TRACK;
                        const willBeShuffled = shuffle === PlayerShuffle.TRACK;
                        const currentIndex = state.player.index;

                        state.player.shuffle = shuffle;

                        if (willBeShuffled) {
                            state.queue.shuffled = generateShuffledIndexes(
                                state.queue.default.length,
                            );

                            // Convert current index to shuffled position if there's a current song
                            if (currentIndex >= 0 && currentIndex < state.queue.default.length) {
                                // Find the shuffled position that corresponds to the current queue position
                                const shuffledPosition = findShuffledPositionForQueueIndex(
                                    currentIndex,
                                    state.queue.shuffled,
                                );
                                if (shuffledPosition !== undefined) {
                                    state.player.index = shuffledPosition;
                                }
                            }
                        } else {
                            // When disabling shuffle, convert shuffled position back to queue position
                            if (
                                wasShuffled &&
                                currentIndex >= 0 &&
                                currentIndex < state.queue.shuffled.length
                            ) {
                                const queuePosition = state.queue.shuffled[currentIndex];
                                if (queuePosition !== undefined) {
                                    state.player.index = queuePosition;
                                }
                            }
                            state.queue.shuffled = [];
                        }
                        cleanupOrphanedSongs(state);
                    });
                },
                setSpeed: (speed: number) => {
                    set((state) => {
                        const normalizedSpeed = Math.max(0.5, Math.min(2, speed));
                        state.player.speed = normalizedSpeed;
                    });
                },
                setTransitionType: (transitionType: PlayerStyle) => {
                    set((state) => {
                        state.player.transitionType = transitionType;
                    });
                },
                setVolume: (volume: number) => {
                    set((state) => {
                        state.player.volume = volume;
                    });
                },
                shuffle: () => {
                    set((state) => {
                        if (state.player.shuffle === PlayerShuffle.TRACK) {
                            state.queue.shuffled = generateShuffledIndexes(
                                state.queue.default.length,
                            );
                        }
                    });
                },
                shuffleAll: () => {
                    set((state) => {
                        const queue = state.getQueue();
                        const currentIndex = state.player.index;
                        const currentSong = queue.items[currentIndex];

                        // If there's a current song playing, keep it in place
                        if (currentSong && currentIndex >= 0 && currentIndex < queue.items.length) {
                            const currentUniqueId = currentSong._uniqueId;
                            const currentQueueIndex = state.queue.default.findIndex(
                                (id) => id === currentUniqueId,
                            );

                            if (currentQueueIndex !== -1) {
                                const beforeItems = state.queue.default.slice(0, currentQueueIndex);
                                const afterItems = state.queue.default.slice(currentQueueIndex + 1);

                                const shuffledBefore = shuffleInPlace([...beforeItems]);
                                const shuffledAfter = shuffleInPlace([...afterItems]);

                                state.queue.default = [
                                    ...shuffledBefore,
                                    currentUniqueId,
                                    ...shuffledAfter,
                                ];
                            } else {
                                // Current song not in default queue, just shuffle everything
                                state.queue.default = shuffleInPlace([...state.queue.default]);
                            }
                        } else {
                            // No current song, shuffle everything
                            state.queue.default = shuffleInPlace([...state.queue.default]);
                        }

                        // Regenerate shuffled indexes if shuffle is enabled
                        regenerateShuffledIndexesIfNeeded(state);
                    });
                },
                shuffleSelected: (items: QueueSong[]) => {
                    set((state) => {
                        const itemUniqueIds = items.map((item) => item._uniqueId);

                        // Find positions of selected items in the default queue
                        const selectedPositions = itemUniqueIds
                            .map((id) => state.queue.default.findIndex((i) => i === id))
                            .filter((idx) => idx !== -1)
                            .sort((a, b) => a - b); // Sort to maintain order

                        if (selectedPositions.length === 0) {
                            return;
                        }

                        // Get the selected items in their current order
                        const selectedItems = selectedPositions.map(
                            (pos) => state.queue.default[pos],
                        );

                        // Shuffle the selected items
                        const shuffledItems = shuffleInPlace([...selectedItems]);

                        // Rebuild the default queue with shuffled selected items
                        const newDefaultQueue = [...state.queue.default];
                        selectedPositions.forEach((pos, i) => {
                            newDefaultQueue[pos] = shuffledItems[i];
                        });

                        state.queue.default = newDefaultQueue;

                        // Regenerate shuffled indexes if shuffle is enabled
                        regenerateShuffledIndexesIfNeeded(state);
                    });
                },
                toggleRepeat: () => {
                    set((state) => {
                        if (state.player.repeat === PlayerRepeat.NONE) {
                            state.player.repeat = PlayerRepeat.ONE;
                        } else if (state.player.repeat === PlayerRepeat.ONE) {
                            state.player.repeat = PlayerRepeat.ALL;
                        } else {
                            state.player.repeat = PlayerRepeat.NONE;
                        }
                    });
                },
                toggleShuffle: () => {
                    set((state) => {
                        const wasShuffled = state.player.shuffle === PlayerShuffle.TRACK;
                        const willBeShuffled = state.player.shuffle !== PlayerShuffle.TRACK;
                        const currentIndex = state.player.index;

                        state.player.shuffle =
                            state.player.shuffle === PlayerShuffle.NONE
                                ? PlayerShuffle.TRACK
                                : PlayerShuffle.NONE;

                        if (willBeShuffled) {
                            // Enabling shuffle: create shuffled indexes with current track as first
                            const combinedLength = state.queue.default.length;

                            if (
                                combinedLength > 0 &&
                                currentIndex >= 0 &&
                                currentIndex < combinedLength
                            ) {
                                // Get the current queue position (actual index in combined queue)
                                const currentQueuePosition = currentIndex;

                                // Create shuffled indexes with current track first
                                const remainingIndexes = Array.from(
                                    { length: combinedLength },
                                    (_, i) => i,
                                ).filter((idx) => idx !== currentQueuePosition);
                                const shuffledRemaining = shuffleInPlace([...remainingIndexes]);

                                state.queue.shuffled = [currentQueuePosition, ...shuffledRemaining];

                                // Set player index to 0 since current track is now first in shuffled array
                                state.player.index = 0;
                            } else {
                                // No current track, just generate shuffled indexes normally
                                state.queue.shuffled = generateShuffledIndexes(combinedLength);
                            }
                        } else {
                            // Disabling shuffle: clear shuffled indexes and convert index back
                            if (
                                wasShuffled &&
                                currentIndex >= 0 &&
                                currentIndex < state.queue.shuffled.length
                            ) {
                                const queuePosition = state.queue.shuffled[currentIndex];
                                if (queuePosition !== undefined) {
                                    state.player.index = queuePosition;
                                }
                            }
                            state.queue.shuffled = [];
                        }
                    });
                },
            })),
        ),
        {
            merge: (persistedState: any, currentState: any) => {
                return merge(currentState, persistedState);
            },
            migrate: async (persistedState, oldVersion) => {
                if (oldVersion < 3) {
                    return {} as PlayerState;
                }

                if (oldVersion === 3) {
                    await migratePlayerStorePersist('player-store');
                    return persistedState as Partial<PlayerState>;
                }

                return persistedState as Partial<PlayerState>;
            },
            name: 'player-store',
            onRehydrateStorage: () => () => {
                usePlayerStoreBase.setState({ hydrated: true });
            },
            partialize: (state) => {
                const shouldRestorePlayQueue = useSettingsStore.getState().general.resume;

                // Exclude playerNum, seekToTimestamp, and status from stored player object
                // These are not needed to be stored since they are ephemeral properties
                // Note: timestamp is now in a separate store and doesn't need to be excluded here
                const excludedPlayerKeys = ['playerNum', 'seekToTimestamp', 'status'];

                // If we're not restoring the play queue, we don't need the index property
                // (it is meaningless without the queue)
                if (!shouldRestorePlayQueue) {
                    excludedPlayerKeys.push('index');
                }

                const player = Object.fromEntries(
                    Object.entries(state.player).filter(
                        ([key]) => !excludedPlayerKeys.includes(key),
                    ),
                ) as typeof state.player;

                if (!shouldRestorePlayQueue) {
                    return { player };
                }

                // Queue pruning and IDB writes are handled in `playerStoreStorage` so we only
                // serialize the large queue when the queue slice reference actually changes.
                return { player, queue: state.queue };
            },
            storage: playerStoreStorage,
            version: 4,
        },
    ),
);

export const usePlayerStore = createSelectors(usePlayerStoreBase);

export const usePlayerActions = () => {
    const actions = usePlayerStoreBase(
        useShallow((state) => ({
            addToQueueByType: state.addToQueueByType,
            addToQueueByUniqueId: state.addToQueueByUniqueId,
            clearQueue: state.clearQueue,
            clearSelected: state.clearSelected,
            decreaseVolume: state.decreaseVolume,
            getQueue: state.getQueue,
            getVisibleQueue: state.getVisibleQueue,
            increaseVolume: state.increaseVolume,
            isFirstTrackInQueue: state.isFirstTrackInQueue,
            isLastTrackInQueue: state.isLastTrackInQueue,
            mediaAutoNext: state.mediaAutoNext,
            mediaNext: state.mediaNext,
            mediaPause: state.mediaPause,
            mediaPlay: state.mediaPlay,
            mediaPlayByIndex: state.mediaPlayByIndex,
            mediaPrevious: state.mediaPrevious,
            mediaSeekToTimestamp: state.mediaSeekToTimestamp,
            mediaSkipBackward: state.mediaSkipBackward,
            mediaSkipForward: state.mediaSkipForward,
            mediaStop: state.mediaStop,
            mediaToggleMute: state.mediaToggleMute,
            mediaTogglePlayPause: state.mediaTogglePlayPause,
            moveSelectedTo: state.moveSelectedTo,
            moveSelectedToBottom: state.moveSelectedToBottom,
            moveSelectedToNext: state.moveSelectedToNext,
            moveSelectedToTop: state.moveSelectedToTop,
            setCrossfadeDuration: state.setCrossfadeDuration,
            setCrossfadeStyle: state.setCrossfadeStyle,
            setPauseOnNextSongEnd: state.setPauseOnNextSongEnd,
            setQueue: state.setQueue,
            setRepeat: state.setRepeat,
            setShuffle: state.setShuffle,
            setSpeed: state.setSpeed,
            setTransitionType: state.setTransitionType,
            setVolume: state.setVolume,
            shuffle: state.shuffle,
            shuffleAll: state.shuffleAll,
            shuffleSelected: state.shuffleSelected,
            toggleRepeat: state.toggleRepeat,
            toggleShuffle: state.toggleShuffle,
        })),
    );

    return useMemo(
        () => ({
            ...actions,
            setTimestamp: setTimestampStore,
        }),
        [actions],
    );
};

export type AddToQueueByPlayType = Play;

export type AddToQueueByUniqueId = {
    edge: 'bottom' | 'left' | 'right' | 'top' | null;
    uniqueId: string;
};

export type AddToQueueType = AddToQueueByPlayType | AddToQueueByUniqueId;

export async function addToQueueByData(type: AddToQueueType, data: Song[]) {
    const items = data.map(toQueueSong);

    if (typeof type === 'string') {
        usePlayerStoreBase.getState().addToQueueByType(items, type);
    } else {
        const normalizedEdge = type.edge === 'top' ? 'top' : 'bottom';
        usePlayerStoreBase.getState().addToQueueByUniqueId(items, type.uniqueId, normalizedEdge);
    }
}

export const subscribePlayerQueue = (
    onChange: (queue: QueueData, prevQueue: QueueData) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.queue,
        (queue, prevQueue) => {
            onChange(queue, prevQueue);
        },
    );
};

export const subscribeCurrentTrack = (
    onChange: (
        properties: { index: number; song: QueueSong | undefined },
        prev: { index: number; song: QueueSong | undefined },
    ) => void,
) => {
    const resolveSong = (sel: {
        index: number;
        songId: string | undefined;
    }): { index: number; song: QueueSong | undefined } => {
        const song =
            sel.songId !== undefined
                ? usePlayerStoreBase.getState().queue.songs[sel.songId]
                : undefined;
        return { index: sel.index, song };
    };

    return usePlayerStoreBase.subscribe(
        // Index-only selector: this fires on every position tick, so it must
        // stay cheap. Resolve just the songId (the id at the current default
        // position) instead of rebuilding the entire queue array via getQueue().
        (state) => {
            let index = state.player.index;

            if (isShuffleEnabled(state)) {
                index = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            return { index, songId: state.queue.default[index] };
        },
        // The full QueueSong is resolved here, in the change callback, which
        // fires rarely (only when the equalityFn below reports a change).
        (sel, prevSel) => {
            onChange(resolveSong(sel), resolveSong(prevSel));
        },
        {
            equalityFn: (a, b) => {
                return a.songId === b.songId;
            },
        },
    );
};

export const subscribeNextSongInsertion = (onChange: (song: QueueSong | undefined) => void) => {
    return usePlayerStoreBase.subscribe(
        (state) => {
            const queue = state.getQueue();
            let queueIndex = state.player.index;
            const repeat = state.player.repeat;

            // If shuffle is enabled, map shuffled position to actual queue position
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(queueIndex, state.queue.shuffled);
            }

            const currentSong = queue.items[queueIndex];

            // Calculate next song based on shuffle and repeat settings
            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                // Calculate next in shuffled order
                const nextShuffledIndex = state.player.index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    const nextQueueIndex = state.queue.shuffled[nextShuffledIndex];
                    nextSong = queue.items[nextQueueIndex];
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to first in shuffled order
                    const firstQueueIndex = state.queue.shuffled[0];
                    nextSong = queue.items[firstQueueIndex];
                }
            } else {
                nextSong = calculateNextSong(queueIndex, queue.items, repeat);
            }

            return {
                currentUniqueId: currentSong?._uniqueId,
                nextSong,
            };
        },
        (current, prev) => {
            if (!prev) {
                return;
            }

            // Still on the same track, but the upcoming song changed (queue edit: insert, reorder, etc.).
            // Do not require the current track's queue index to stay fixed — e.g. inserting *before* the
            // current item shifts its index in `queue.default`, and the old check missed that case.
            const sameTrackStillPlaying =
                current.currentUniqueId !== undefined &&
                current.currentUniqueId === prev.currentUniqueId;

            if (sameTrackStillPlaying && current.nextSong?._uniqueId !== prev.nextSong?._uniqueId) {
                onChange(current.nextSong);
            }
        },
        {
            // Always allow the subscription to fire so we can check conditions in the callback
            equalityFn: () => false,
        },
    );
};

export const subscribePlayerVolume = (
    onChange: (properties: { volume: number }, prev: { volume: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.volume,
        (volume, prevVolume) => {
            onChange({ volume }, { volume: prevVolume });
        },
    );
};

export const subscribePlayerStatus = (
    onChange: (properties: { status: PlayerStatus }, prev: { status: PlayerStatus }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.status,
        (status, prevStatus) => {
            onChange({ status }, { status: prevStatus });
        },
    );
};

export const subscribePlayerSeekToTimestamp = (
    onChange: (properties: { timestamp: number }, prev: { timestamp: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.seekToTimestamp,
        (timestamp, prevTimestamp) => {
            onChange(
                { timestamp: parseUniqueSeekToTimestamp(timestamp) },
                { timestamp: parseUniqueSeekToTimestamp(prevTimestamp) },
            );
        },
    );
};

export const subscribePlayerMute = (
    onChange: (properties: { muted: boolean }, prev: { muted: boolean }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.muted,
        (muted, prevMuted) => {
            onChange({ muted }, { muted: prevMuted });
        },
    );
};

export const subscribePlayerSpeed = (
    onChange: (properties: { speed: number }, prev: { speed: number }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.speed,
        (speed, prevSpeed) => {
            onChange({ speed }, { speed: prevSpeed });
        },
    );
};

export const subscribePlayerRepeat = (
    onChange: (properties: { repeat: PlayerRepeat }, prev: { repeat: PlayerRepeat }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.repeat,
        (repeat, prevRepeat) => {
            onChange({ repeat }, { repeat: prevRepeat });
        },
    );
};

export const subscribePlayerShuffle = (
    onChange: (properties: { shuffle: PlayerShuffle }, prev: { shuffle: PlayerShuffle }) => void,
) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.player.shuffle,
        (shuffle, prevShuffle) => {
            onChange({ shuffle }, { shuffle: prevShuffle });
        },
    );
};

export const subscribeQueueCleared = (onChange: () => void) => {
    return usePlayerStoreBase.subscribe(
        (state) => state.queue,
        (queue, prevQueue) => {
            // Detect if queue became empty
            const wasNotEmpty = prevQueue.default.length > 0;
            const isEmpty = queue.default.length === 0;

            if (wasNotEmpty && isEmpty) {
                onChange();
            }
        },
    );
};

export const usePlayerProperties = () => {
    return usePlayerStoreBase(
        useShallow((state) => ({
            crossfadeDuration: state.player.crossfadeDuration,
            crossfadeStyle: state.player.crossfadeStyle,
            isMuted: state.player.muted,
            playerNum: state.player.playerNum,
            repeat: state.player.repeat,
            shuffle: state.player.shuffle,
            speed: state.player.speed,
            status: state.player.status,
            transitionType: state.player.transitionType,
            volume: state.player.volume,
        })),
    );
};

export const usePlayerDuration = () => {
    return usePlayerStoreBase((state) => {
        let index = state.player.index;

        // If shuffle is enabled, map shuffled position to actual queue position
        if (state.player.shuffle === PlayerShuffle.TRACK && state.queue.shuffled.length > 0) {
            if (index >= 0 && index < state.queue.shuffled.length) {
                index = state.queue.shuffled[index];
            }
        }

        // O(1) lookup — avoid `state.getQueue()` which would build a full QueueSong[] copy.
        const uniqueId = state.queue.default[index];
        return uniqueId ? state.queue.songs[uniqueId]?.duration : undefined;
    });
};

/**
 * O(1) lookup into the song map by default-queue index. Returns undefined for
 * out-of-range indices or missing songs. Used by `usePlayerData` to avoid
 * materializing the full queue items array on every store mutation.
 */
function getSongAtQueueIndex(
    state: { queue: { default: string[]; songs: Record<string, QueueSong> } },
    queueIndex: number,
): QueueSong | undefined {
    const uniqueId = state.queue.default[queueIndex];
    if (!uniqueId) {
        return undefined;
    }
    return state.queue.songs[uniqueId];
}

export const usePlayerData = (): PlayerData => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const defaultLength = state.queue.default.length;
            const index = state.player.index;

            // If shuffle is enabled, map shuffled position to actual queue position for display
            let queueIndex = index;
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            const currentSong = getSongAtQueueIndex(state, queueIndex);
            const repeat = state.player.repeat;

            // For previousSong calculation, we need to consider the shuffled order
            let previousSong: QueueSong | undefined;
            if (isShuffleEnabled(state)) {
                // Calculate previous in shuffled order
                const previousShuffledIndex = index - 1;
                if (previousShuffledIndex >= 0) {
                    previousSong = getSongAtQueueIndex(
                        state,
                        state.queue.shuffled[previousShuffledIndex],
                    );
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to last in shuffled order
                    const lastShuffledIndex = state.queue.shuffled.length - 1;
                    previousSong = getSongAtQueueIndex(
                        state,
                        state.queue.shuffled[lastShuffledIndex],
                    );
                }
            } else {
                previousSong =
                    queueIndex > 0 ? getSongAtQueueIndex(state, queueIndex - 1) : undefined;
            }

            // For nextSong calculation, we need to consider the shuffled order
            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                // Calculate next in shuffled order
                const nextShuffledIndex = index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    nextSong = getSongAtQueueIndex(state, state.queue.shuffled[nextShuffledIndex]);
                } else if (repeat === PlayerRepeat.ALL) {
                    // Wrap to first in shuffled order
                    nextSong = getSongAtQueueIndex(state, state.queue.shuffled[0]);
                }
            } else if (repeat === PlayerRepeat.ONE) {
                nextSong = currentSong;
            } else if (repeat === PlayerRepeat.ALL) {
                const nextIndex = queueIndex === defaultLength - 1 ? 0 : queueIndex + 1;
                nextSong = getSongAtQueueIndex(state, nextIndex);
            } else {
                nextSong = getSongAtQueueIndex(state, queueIndex + 1);
            }

            const { player1, player2 } = getDualPlayerSongs(
                state.player.playerNum,
                currentSong,
                nextSong,
                repeat,
            );

            return {
                currentSong,
                index: queueIndex, // Return the actual queue position for display
                nextSong,
                num: state.player.playerNum,
                player1,
                player2,
                previousSong,
                queueLength: defaultLength,
                status: state.player.status,
            };
        }),
    );
};

/**
 * Leaf selector for the dual-player audio orchestrator. The audio player only
 * needs the active player index, the two side songs, and the play/pause status;
 * subscribing to the full `usePlayerData` payload would re-render the player on
 * every shuffle/repeat/queueLength change, which during a heavy session means
 * tearing down progress callbacks and re-binding react-player props on every
 * insert into the queue. Returning the narrow tuple keeps re-renders pinned to
 * the four fields that actually drive audio output.
 */
export const usePlayerCoreData = (): {
    num: 1 | 2;
    player1: QueueSong | undefined;
    player2: QueueSong | undefined;
    status: PlayerStatus;
} => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const index = state.player.index;
            const defaultLength = state.queue.default.length;

            let queueIndex = index;
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(index, state.queue.shuffled);
            }

            const currentSong = getSongAtQueueIndex(state, queueIndex);
            const repeat = state.player.repeat;

            let nextSong: QueueSong | undefined;
            if (isShuffleEnabled(state) && repeat !== PlayerRepeat.ONE) {
                const nextShuffledIndex = index + 1;
                if (nextShuffledIndex < state.queue.shuffled.length) {
                    nextSong = getSongAtQueueIndex(state, state.queue.shuffled[nextShuffledIndex]);
                } else if (repeat === PlayerRepeat.ALL) {
                    nextSong = getSongAtQueueIndex(state, state.queue.shuffled[0]);
                }
            } else if (repeat === PlayerRepeat.ONE) {
                nextSong = currentSong;
            } else if (repeat === PlayerRepeat.ALL) {
                const nextIndex = queueIndex === defaultLength - 1 ? 0 : queueIndex + 1;
                nextSong = getSongAtQueueIndex(state, nextIndex);
            } else {
                nextSong = getSongAtQueueIndex(state, queueIndex + 1);
            }

            const { player1, player2 } = getDualPlayerSongs(
                state.player.playerNum,
                currentSong,
                nextSong,
                repeat,
            );

            return {
                num: state.player.playerNum,
                player1,
                player2,
                status: state.player.status,
            };
        }),
    );
};

/**
 * Transition-specific subset of player properties: anything that the dual-player
 * progress callbacks need to compute crossfade/gapless timing. Avoids
 * re-rendering when unrelated `usePlayerProperties` fields change (e.g. mute,
 * shuffle, repeat). Kept separate from `usePlayerCoreData` because these change
 * on user-config, not on track change.
 */
export const usePlayerTransition = (): {
    crossfadeDuration: number;
    crossfadeStyle: CrossfadeStyle;
    speed: number;
    transitionType: PlayerStyle;
} => {
    return usePlayerStoreBase(
        useShallow((state) => ({
            crossfadeDuration: state.player.crossfadeDuration,
            crossfadeStyle: state.player.crossfadeStyle,
            speed: state.player.speed,
            transitionType: state.player.transitionType,
        })),
    );
};

/**
 * Audio-player-only subset: current song + status. Used by single-stream
 * back-ends (mpv, etc.) that don't need the next song.
 */
export const useActiveSongStatus = (): {
    currentSong: QueueSong | undefined;
    status: PlayerStatus;
} => {
    return usePlayerStoreBase(
        useShallow((state) => {
            let queueIndex = state.player.index;
            if (isShuffleEnabled(state)) {
                queueIndex = mapShuffledToQueueIndex(queueIndex, state.queue.shuffled);
            }
            return {
                currentSong: getSongAtQueueIndex(state, queueIndex),
                status: state.player.status,
            };
        }),
    );
};

export const updateQueueFavorites = (ids: string[], favorite: boolean) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.userFavorite = favorite;
            }
        });
    });
};

export const updateQueueRatings = (ids: string[], rating: null | number) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.userRating = rating;
            }
        });
    });
};

export const incrementQueuePlayCount = (ids: string[]) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (ids.includes(song.id)) {
                song.playCount = (song.playCount || 0) + 1;
            }
        });
    });
};

export const updateQueueSong = (songId: string, updatedSong: Song) => {
    usePlayerStoreBase.setState((state) => {
        Object.values(state.queue.songs).forEach((song) => {
            if (song.id === songId) {
                const uniqueId = song._uniqueId;
                state.queue.songs[song._uniqueId] = {
                    ...updatedSong,
                    _contextPlaylistId: song._contextPlaylistId,
                    _uniqueId: uniqueId,
                };
            }
        });
    });
};

export const useCurrentPlaylistContextId = () => {
    return usePlayerStoreBase((state) => state.getCurrentSong()?._contextPlaylistId ?? null);
};

export const usePlayerMuted = () => {
    return usePlayerStoreBase((state) => state.player.muted);
};

export const usePlayerRepeat = () => {
    return usePlayerStoreBase((state) => state.player.repeat);
};

export const usePlayerShuffle = () => {
    return usePlayerStoreBase((state) => state.player.shuffle);
};

export const usePlayerStatus = () => {
    return usePlayerStoreBase((state) => state.player.status);
};

export const usePlayerHydrated = () => {
    return usePlayerStoreBase((state) => state.hydrated);
};

export const usePlayerVolume = () => {
    return usePlayerStoreBase((state) => state.player.volume);
};

export const usePlayerSpeed = () => {
    return usePlayerStoreBase((state) => state.player.speed);
};

export const usePlayerSong = () => {
    return usePlayerStoreBase(
        (state) => {
            return state.getCurrentSong();
        },
        (prev, next) => {
            return (
                prev?._uniqueId === next?._uniqueId &&
                prev?.userFavorite === next?.userFavorite &&
                prev?.userRating === next?.userRating
            );
        },
    );
};

export const usePlayerSongProperties = <T extends keyof QueueSong>(
    properties: T[],
): Partial<Pick<QueueSong, T>> => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const song = state.getCurrentSong();
            if (!song) {
                return {};
            }

            const result = {} as Pick<QueueSong, T>;

            for (const prop of properties) {
                result[prop] = song[prop];
            }
            return result;
        }),
    );
};

export const usePlayerNum = () => {
    return usePlayerStoreBase((state) => state.player.playerNum);
};

export const usePlayerQueue = () => {
    return usePlayerStoreBase(
        useShallow((state) => {
            const songs = state.queue.songs;
            const queue = state.queue.default;
            const result: QueueSong[] = [];
            for (const id of queue) {
                const song = songs[id];
                if (song) result.push(song);
            }
            return result;
        }),
    );
};

function cleanupOrphanedSongs(state: any): boolean {
    const allQueueIds = new Set([
        ...state.queue.default,
        // shuffled now contains indexes, not uniqueIds, so we don't include it here
    ]);

    const songs = state.queue.songs;
    const songIds = Object.keys(songs);
    let hasOrphans = false;
    const orphanedIds: string[] = [];

    for (const songId of songIds) {
        if (!allQueueIds.has(songId)) {
            orphanedIds.push(songId);
            hasOrphans = true;
        }
    }

    if (hasOrphans) {
        const cleanedSongs: Record<string, QueueSong> = {};
        for (const songId of songIds) {
            if (!orphanedIds.includes(songId)) {
                cleanedSongs[songId] = songs[songId];
            }
        }
        state.queue.songs = cleanedSongs;
    }

    return hasOrphans;
}

function parseUniqueSeekToTimestamp(timestamp: string) {
    return Number(timestamp.split('-')[0]);
}

function recalculatePlayerIndex(state: any, queue: string[]) {
    const currentTrack = state.getCurrentSong() as QueueSong | undefined;

    if (!currentTrack) {
        return;
    }

    const index = queue.findIndex((id) => id === currentTrack._uniqueId);

    // Under shuffle, `player.index` is a position WITHIN queue.shuffled (which
    // must already be remapped to the new default order before calling this),
    // not a default-order position.
    if (isShuffleEnabled(state)) {
        const shuffledPosition = state.queue.shuffled.findIndex((idx: number) => idx === index);
        state.player.index = Math.max(0, shuffledPosition);
    } else {
        state.player.index = Math.max(0, index);
    }
}

// Rebuilds queue.shuffled after queue.default was reordered from `oldDefault`
// to `newDefault`, keeping every shuffled entry pointing at the same song.
// Entries whose song was removed are dropped; songs new to the queue are
// shuffled into the not-yet-played region after the current track.
function remapShuffledAfterReorder(state: any, oldDefault: string[], newDefault: string[]) {
    if (!isShuffleEnabled(state)) {
        return;
    }

    const newIndexById = new Map<string, number>();
    newDefault.forEach((id, idx) => newIndexById.set(id, idx));

    const seen = new Set<number>();
    const remapped: number[] = [];
    for (const oldIdx of state.queue.shuffled as number[]) {
        const id = oldDefault[oldIdx];
        const newIdx = id === undefined ? undefined : newIndexById.get(id);
        if (newIdx !== undefined && !seen.has(newIdx)) {
            seen.add(newIdx);
            remapped.push(newIdx);
        }
    }

    const added: number[] = [];
    for (let idx = 0; idx < newDefault.length; idx += 1) {
        if (!seen.has(idx)) added.push(idx);
    }

    if (added.length > 0) {
        const currentTrack = state.getCurrentSong() as QueueSong | undefined;
        const currentNewIndex = currentTrack ? newIndexById.get(currentTrack._uniqueId) : undefined;
        const currentPosition =
            currentNewIndex === undefined
                ? -1
                : remapped.findIndex((idx) => idx === currentNewIndex);
        state.queue.shuffled = addIndexesToShuffled(remapped, currentPosition, added);
    } else {
        state.queue.shuffled = remapped;
    }
}

function toQueueSong(item: Song): QueueSong {
    return {
        ...item,
        _uniqueId: nanoid(),
    };
}

// We need to use a unique id so that the equalityFn can work if attempting to set the same timestamp
function uniqueSeekToTimestamp(timestamp: number) {
    return `${timestamp}-${nanoid()}`;
}
