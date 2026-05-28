import type {
    RemoteDevice,
    RemoteMirrored,
    RemoteMirroredPlayState,
    RemoteTargetStatus,
} from '/@/renderer/features/jellyfin-remote-target/types';

import { create } from 'zustand';

/**
 * Fields we can put on optimistic hold. When a command is dispatched we
 * record the *expected* server value here and ignore poll updates that
 * disagree until either the poll catches up (clears the hold immediately)
 * or the hold timer expires (~2s) and we trust the server again.
 *
 * This kills the "I just paused but the seekbar jumped back to playing"
 * class of regression: the next `/Sessions` poll lands carrying the
 * pre-pause state because the receiver hasn't pushed its PlaybackProgress
 * yet — without the hold we'd overwrite our optimistic value.
 */
export interface RemoteHold<T = unknown> {
    expected: T;
    until: number;
}

export type RemoteHoldField =
    | 'isPaused'
    | 'nowPlayingItemId'
    | 'positionMs'
    | 'repeatMode'
    | 'shuffle'
    | 'volume';

export type RemoteHolds = Partial<Record<RemoteHoldField, RemoteHold>>;

/** Default hold window — 2s is enough for a poll RTT + receiver reaction. */
export const DEFAULT_HOLD_MS = 2_000;
/** Seeks need a touch more headroom because the receiver may re-buffer. */
export const SEEK_HOLD_MS = 3_000;
/** Position tolerance for hold-clear comparisons (ms). */
export const POSITION_HOLD_TOLERANCE_MS = 1_500;
/** Volume tolerance for hold-clear comparisons (0-100). */
export const VOLUME_HOLD_TOLERANCE = 2;

interface RemoteTargetState {
    actions: {
        /**
         * Apply a mirror update produced by a poll or a session-push frame.
         * Unlike `setMirrored`, this respects per-field optimistic holds for
         * playState so an in-flight command's optimistic value isn't reverted
         * by a stale server frame.
         */
        applyMirrorFromServer: (mirrored: Partial<RemoteMirrored>) => void;
        clearHold: (field: RemoteHoldField) => void;
        clearTarget: () => void;
        /**
         * Record an optimistic expectation for `field`. Subsequent server
         * frames that disagree are ignored for that field until the hold
         * expires or a frame matching `expected` clears it.
         */
        hold: (field: RemoteHoldField, expected: unknown, durationMs?: number) => void;
        /**
         * Optimistic next-track. Advances queueIndex, swaps nowPlayingItem,
         * resets the position clock, and installs a nowPlayingItemId hold so
         * a stale `/Sessions` frame can't snap us back to the previous song.
         * No-op when queue/index aren't known.
         */
        optimisticNext: () => void;
        /** Optimistic previous-track — mirror of optimisticNext. */
        optimisticPrevious: () => void;
        /**
         * Optimistic seek. Snaps the seek bar to `positionMs` immediately and
         * installs a SEEK_HOLD_MS hold so the next stale poll doesn't yank
         * the bar back to the pre-seek position.
         */
        optimisticSeek: (positionMs: number) => void;
        /** Optimistically merge into mirrored.playState for instant UI feedback
         *  before the next /Sessions poll reconciles. Also installs a hold so
         *  the next poll won't clobber what we just patched. */
        patchPlayState: (partial: Partial<RemoteMirroredPlayState>) => void;
        reconcileSession: (session: {
            capabilities: string[];
            deviceName: string;
            sessionId: string;
        }) => void;
        setDeviceList: (devices: RemoteDevice[]) => void;
        setMirrored: (mirrored: Partial<RemoteMirrored>) => void;
        /** Optimistic pause/resume that also re-anchors the interpolation
         *  clock so the seek bar freezes/continues from the right spot. */
        setPaused: (isPaused: boolean) => void;
        setPickerOpen: (open: boolean) => void;
        setPollerActive: (active: boolean) => void;
        setPollError: (error: null | string) => void;
        setStatus: (status: RemoteTargetStatus) => void;
        setTarget: (target: {
            capabilities: string[];
            deviceId: string;
            deviceName: string;
            sessionId: string;
        }) => void;
    };
    deviceList: RemoteDevice[];
    /**
     * `true` once the poller has completed at least one /Sessions tick for
     * the current session. Lets the picker show a "Searching…" state instead
     * of "No devices" for the brief window between opening the popover and
     * the first response landing.
     */
    hasPolledOnce: boolean;
    /** Per-field optimistic holds — see `RemoteHoldField`. */
    holds: RemoteHolds;
    mirrored: RemoteMirrored;
    pickerOpen: boolean;
    /**
     * Last error message from the /Sessions poll, or null if the last poll
     * succeeded. Surfaced in the picker so a silent network/auth failure
     * doesn't masquerade as "no devices online".
     */
    pollError: null | string;
    sessionId: null | string; // re-resolved each Sessions tick from targetDeviceId
    status: RemoteTargetStatus;
    targetDeviceId: null | string;
    targetDeviceName: null | string;
}

const emptyMirrored: RemoteMirrored = {
    capabilities: [],
    nowPlayingItem: null,
    playState: {
        isPaused: true,
        positionMs: 0,
        positionSampledAt: 0,
        repeatMode: 'RepeatNone',
        shuffle: false,
        volume: 100,
    },
    queue: [],
    queueIndex: -1,
};

/**
 * Compare an incoming server value to a held expectation. Returns true when
 * they agree (within a per-field tolerance) so the hold can clear.
 */
const valuesAgree = (field: RemoteHoldField, expected: unknown, incoming: unknown): boolean => {
    if (field === 'positionMs') {
        if (typeof expected !== 'number' || typeof incoming !== 'number') return false;
        return Math.abs(expected - incoming) <= POSITION_HOLD_TOLERANCE_MS;
    }
    if (field === 'volume') {
        if (typeof expected !== 'number' || typeof incoming !== 'number') return false;
        return Math.abs(expected - incoming) <= VOLUME_HOLD_TOLERANCE;
    }
    return expected === incoming;
};

const extractFieldValue = (
    field: RemoteHoldField,
    mirrored: Partial<RemoteMirrored>,
): { present: boolean; value: unknown } => {
    if (field === 'nowPlayingItemId') {
        if (!('nowPlayingItem' in mirrored)) return { present: false, value: undefined };
        return { present: true, value: mirrored.nowPlayingItem?.id ?? null };
    }
    if (!mirrored.playState || !(field in mirrored.playState)) {
        return { present: false, value: undefined };
    }
    return {
        present: true,
        value: (mirrored.playState as unknown as Record<string, unknown>)[field],
    };
};

export const useRemoteTargetStore = create<RemoteTargetState>((set) => ({
    actions: {
        applyMirrorFromServer: (incoming) =>
            set((s) => {
                const now = Date.now();
                const holds = { ...s.holds };
                let mirrored: RemoteMirrored = { ...s.mirrored, ...incoming };

                // Apply the playState merge then revert held fields that
                // disagree with their optimistic expectation.
                if (incoming.playState) {
                    const merged: RemoteMirroredPlayState = {
                        ...s.mirrored.playState,
                        ...incoming.playState,
                    };
                    const fields: RemoteHoldField[] = [
                        'isPaused',
                        'positionMs',
                        'volume',
                        'repeatMode',
                        'shuffle',
                    ];
                    for (const field of fields) {
                        const hold = holds[field];
                        if (!hold) continue;
                        const incomingValue = (
                            incoming.playState as unknown as Record<string, unknown>
                        )[field];
                        if (incomingValue === undefined) continue;
                        if (valuesAgree(field, hold.expected, incomingValue)) {
                            delete holds[field];
                            continue;
                        }
                        if (now < hold.until) {
                            // Hold still active — revert this field to its
                            // optimistic value so the UI doesn't flicker.
                            (merged as unknown as Record<string, unknown>)[field] = hold.expected;
                        } else {
                            // Hold expired — trust the server.
                            delete holds[field];
                        }
                    }
                    mirrored = { ...mirrored, playState: merged };
                }

                // nowPlayingItem hold — gates a track-skip optimistically.
                const trackHold = holds.nowPlayingItemId;
                if (trackHold && 'nowPlayingItem' in incoming) {
                    const incomingId = incoming.nowPlayingItem?.id ?? null;
                    if (valuesAgree('nowPlayingItemId', trackHold.expected, incomingId)) {
                        delete holds.nowPlayingItemId;
                    } else if (now < trackHold.until) {
                        mirrored = { ...mirrored, nowPlayingItem: s.mirrored.nowPlayingItem };
                    } else {
                        delete holds.nowPlayingItemId;
                    }
                }

                return { holds, mirrored };
            }),
        clearHold: (field) =>
            set((s) => {
                if (!s.holds[field]) return {};
                const holds = { ...s.holds };
                delete holds[field];
                return { holds };
            }),
        clearTarget: () =>
            set({
                holds: {},
                mirrored: emptyMirrored,
                sessionId: null,
                status: 'idle',
                targetDeviceId: null,
                targetDeviceName: null,
            }),
        hold: (field, expected, durationMs = DEFAULT_HOLD_MS) =>
            set((s) => ({
                holds: {
                    ...s.holds,
                    [field]: { expected, until: Date.now() + durationMs },
                },
            })),
        optimisticNext: () =>
            set((s) => {
                const queue = s.mirrored.queue;
                const idx = s.mirrored.queueIndex;
                if (queue.length === 0 || idx < 0 || idx + 1 >= queue.length) {
                    // Unknown next track — still freeze the current item via a
                    // brief hold so a stale frame can't bounce position.
                    const now = Date.now();
                    return {
                        holds: {
                            ...s.holds,
                            positionMs: { expected: 0, until: now + DEFAULT_HOLD_MS },
                        },
                        mirrored: {
                            ...s.mirrored,
                            playState: {
                                ...s.mirrored.playState,
                                positionMs: 0,
                                positionSampledAt: now,
                            },
                        },
                    };
                }
                const nextItem = queue[idx + 1];
                const now = Date.now();
                return {
                    holds: {
                        ...s.holds,
                        nowPlayingItemId: { expected: nextItem.id, until: now + DEFAULT_HOLD_MS },
                        positionMs: { expected: 0, until: now + DEFAULT_HOLD_MS },
                    },
                    mirrored: {
                        ...s.mirrored,
                        nowPlayingItem: nextItem,
                        playState: {
                            ...s.mirrored.playState,
                            isPaused: false,
                            positionMs: 0,
                            positionSampledAt: now,
                        },
                        queueIndex: idx + 1,
                    },
                };
            }),
        optimisticPrevious: () =>
            set((s) => {
                const queue = s.mirrored.queue;
                const idx = s.mirrored.queueIndex;
                if (queue.length === 0 || idx <= 0) {
                    const now = Date.now();
                    return {
                        holds: {
                            ...s.holds,
                            positionMs: { expected: 0, until: now + DEFAULT_HOLD_MS },
                        },
                        mirrored: {
                            ...s.mirrored,
                            playState: {
                                ...s.mirrored.playState,
                                positionMs: 0,
                                positionSampledAt: now,
                            },
                        },
                    };
                }
                const prevItem = queue[idx - 1];
                const now = Date.now();
                return {
                    holds: {
                        ...s.holds,
                        nowPlayingItemId: { expected: prevItem.id, until: now + DEFAULT_HOLD_MS },
                        positionMs: { expected: 0, until: now + DEFAULT_HOLD_MS },
                    },
                    mirrored: {
                        ...s.mirrored,
                        nowPlayingItem: prevItem,
                        playState: {
                            ...s.mirrored.playState,
                            isPaused: false,
                            positionMs: 0,
                            positionSampledAt: now,
                        },
                        queueIndex: idx - 1,
                    },
                };
            }),
        optimisticSeek: (positionMs) =>
            set((s) => {
                const now = Date.now();
                return {
                    holds: {
                        ...s.holds,
                        positionMs: { expected: positionMs, until: now + SEEK_HOLD_MS },
                    },
                    mirrored: {
                        ...s.mirrored,
                        playState: {
                            ...s.mirrored.playState,
                            positionMs,
                            positionSampledAt: now,
                        },
                    },
                };
            }),
        patchPlayState: (partial) =>
            set((s) => {
                // Install holds for every patched field so the next poll
                // doesn't clobber them. This is the optimistic-update path.
                const holds: RemoteHolds = { ...s.holds };
                const until = Date.now() + DEFAULT_HOLD_MS;
                for (const key of Object.keys(partial) as Array<keyof RemoteMirroredPlayState>) {
                    if (key === 'positionSampledAt') continue;
                    if (key === 'isPaused' && partial.isPaused !== undefined) {
                        holds.isPaused = { expected: partial.isPaused, until };
                    } else if (key === 'volume' && partial.volume !== undefined) {
                        holds.volume = { expected: partial.volume, until };
                    } else if (key === 'positionMs' && partial.positionMs !== undefined) {
                        holds.positionMs = {
                            expected: partial.positionMs,
                            until: Date.now() + SEEK_HOLD_MS,
                        };
                    } else if (key === 'repeatMode' && partial.repeatMode !== undefined) {
                        holds.repeatMode = { expected: partial.repeatMode, until };
                    } else if (key === 'shuffle' && partial.shuffle !== undefined) {
                        holds.shuffle = { expected: partial.shuffle, until };
                    }
                }
                return {
                    holds,
                    mirrored: { ...s.mirrored, playState: { ...s.mirrored.playState, ...partial } },
                };
            }),
        reconcileSession: ({ capabilities, deviceName, sessionId }) =>
            set((s) => ({
                mirrored: { ...s.mirrored, capabilities },
                sessionId,
                status: 'connected',
                targetDeviceName: deviceName,
            })),
        setDeviceList: (devices) => set({ deviceList: devices, hasPolledOnce: true }),
        setMirrored: (partial) => set((s) => ({ mirrored: { ...s.mirrored, ...partial } })),
        setPaused: (isPaused) =>
            set((s) => {
                const ps = s.mirrored.playState;
                const now = Date.now();
                // Re-anchor the interpolation clock: freeze at the current
                // projected position (pause) or resume from it (play).
                const current =
                    ps.isPaused || ps.positionSampledAt === 0
                        ? ps.positionMs
                        : ps.positionMs + Math.max(0, now - ps.positionSampledAt);
                return {
                    holds: {
                        ...s.holds,
                        isPaused: { expected: isPaused, until: now + DEFAULT_HOLD_MS },
                    },
                    mirrored: {
                        ...s.mirrored,
                        playState: {
                            ...ps,
                            isPaused,
                            positionMs: current,
                            positionSampledAt: now,
                        },
                    },
                };
            }),
        setPickerOpen: (open) => set({ pickerOpen: open }),
        setPollerActive: (active) =>
            set(active ? {} : { hasPolledOnce: false, holds: {}, pollError: null }),
        setPollError: (error) => set({ pollError: error }),
        setStatus: (status) => set({ status }),
        setTarget: ({ capabilities, deviceId, deviceName, sessionId }) =>
            set(() => ({
                holds: {},
                mirrored: { ...emptyMirrored, capabilities },
                sessionId,
                status: 'connected',
                targetDeviceId: deviceId,
                targetDeviceName: deviceName,
            })),
    },
    deviceList: [],
    hasPolledOnce: false,
    holds: {},
    mirrored: emptyMirrored,
    pickerOpen: false,
    pollError: null,
    sessionId: null,
    status: 'idle',
    targetDeviceId: null,
    targetDeviceName: null,
}));

export const useRemoteTargetActions = () => useRemoteTargetStore((s) => s.actions);

// Re-export for tests / instrumentation.
export { extractFieldValue, valuesAgree };
