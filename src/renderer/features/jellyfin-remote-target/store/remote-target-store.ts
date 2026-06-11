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
    | 'isMuted'
    | 'isPaused'
    | 'nowPlayingItemId'
    | 'positionMs'
    // Finding 1: queueIndex is a TOP-LEVEL mirrored field (not under playState).
    // optimisticNext/Previous + mediaPlayByIndex install this hold so a stale
    // /Sessions frame that recomputes the OLD index from the not-yet-updated
    // NowPlayingItem can't snap the queue highlight back to the previous track.
    | 'queueIndex'
    | 'repeatMode'
    | 'shuffle'
    | 'volume';

export type RemoteHolds = Partial<Record<RemoteHoldField, RemoteHold>>;

/**
 * Input shape accepted by `applyMirrorFromServer`. Deeper-partial than
 * `Partial<RemoteMirrored>` so a server frame can carry just the subset of
 * play-state fields it actually knows about (e.g. an older MQTT publisher
 * with no `mut` field, or a Jellyfin session payload that omits
 * VolumeLevel). The reducer merges field-by-field with the prior mirrored
 * state, so a missing field means "unchanged" — never "reset to default".
 */
export type RemoteMirrorInput = Omit<Partial<RemoteMirrored>, 'playState'> & {
    playState?: Partial<RemoteMirroredPlayState>;
};

/**
 * Default hold window. Used to be 2s; raised because the receiver's
 * PlaybackProgress push cadence is itself ~3s and the controller's poll
 * default is 2s. The old window expired before either lane had pushed the
 * truthful state, so the next poll would clobber the optimistic value with
 * a stale frame and the UI would visibly flip back to the pre-command
 * state. 6s sticks long enough for either lane to converge, while still
 * being short enough that a truly dropped command surfaces a visible
 * snap-back instead of staying optimistically lying forever.
 */
export const DEFAULT_HOLD_MS = 6_000;
/**
 * Seeks need the same headroom as everything else now — used to be 3s
 * which still beat the 2s default. With the default lifted to 6s the
 * seek-specific value is the floor; keep it identical so a seek doesn't
 * accidentally clear before an isPaused hold from the same gesture.
 */
export const SEEK_HOLD_MS = 6_000;
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
        applyMirrorFromServer: (mirrored: RemoteMirrorInput) => void;
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
            /** Id of the server that owns this target — see `ownerServerId`.
             *  Optional: callers without a server context (and tests) omit it,
             *  in which case the target carries no server binding (null) and the
             *  getRemoteCtx server-match guard is a no-op for it. */
            ownerServerId?: string;
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
    /**
     * Id of the server that established the current target (E1). `getRemoteCtx`
     * refuses to build a command when the live server id no longer matches, so
     * a server switch can never POST transport commands to the *new* server
     * using the *old* session id. Null when there is no target.
     */
    ownerServerId: null | string;
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
    nextItemId: null,
    nowPlayingItem: null,
    playState: {
        isMuted: false,
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

export const useRemoteTargetStore = create<RemoteTargetState>((set) => ({
    actions: {
        applyMirrorFromServer: (incoming) =>
            set((s) => {
                const now = Date.now();
                const holds = { ...s.holds };
                // The incoming `playState` is a deep partial — merge it onto
                // the current play-state instead of letting the outer spread
                // replace the whole sub-object. Without this, a frame that
                // omits e.g. `isMuted` would type-narrow `mirrored.playState`
                // back to an incomplete shape.
                const { playState: incomingPlayState, ...incomingTopLevel } = incoming;
                let mirrored: RemoteMirrored = { ...s.mirrored, ...incomingTopLevel };

                // Apply the playState merge then revert held fields that
                // disagree with their optimistic expectation.
                if (incomingPlayState) {
                    const merged: RemoteMirroredPlayState = {
                        ...s.mirrored.playState,
                        ...incomingPlayState,
                    };
                    const fields: RemoteHoldField[] = [
                        'isPaused',
                        'isMuted',
                        'positionMs',
                        'volume',
                        'repeatMode',
                        'shuffle',
                    ];
                    for (const field of fields) {
                        const hold = holds[field];
                        if (!hold) continue;
                        const incomingValue = (
                            incomingPlayState as unknown as Record<string, unknown>
                        )[field];
                        if (incomingValue === undefined) continue;
                        if (valuesAgree(field, hold.expected, incomingValue)) {
                            delete holds[field];
                            continue;
                        }
                        if (now < hold.until) {
                            // Hold still active — revert this field to its
                            // optimistic value so the UI doesn't flicker.
                            if (field === 'positionMs') {
                                merged.positionMs = hold.expected as number;
                                // A5: also restore the interpolation ANCHOR. The
                                // incoming frame's fresh positionSampledAt was just
                                // merged in via `...incomingPlayState`; if we pin
                                // positionMs to the seek target but keep that fresh
                                // sample time, interpolatePositionMs restarts from the
                                // target on every poll — the playhead snaps back each
                                // tick for the whole hold window. Re-anchoring to the
                                // prior sample time lets it advance continuously from
                                // the seek instant.
                                merged.positionSampledAt = s.mirrored.playState.positionSampledAt;
                            } else {
                                (merged as unknown as Record<string, unknown>)[field] =
                                    hold.expected;
                            }
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

                // Finding 1: queueIndex hold — a stale frame recomputes the OLD
                // index from the not-yet-updated NowPlayingItem and would snap
                // the queue highlight back. Revert the incoming queueIndex to the
                // optimistic value while the hold is live, and clear on agreement
                // or expiry. queueIndex is a top-level field, so an incoming
                // value arrives via `incomingTopLevel` (already spread above) and
                // we restore from the prior mirrored value.
                const qIdxHold = holds.queueIndex;
                if (qIdxHold && 'queueIndex' in incoming) {
                    const incomingIdx = incoming.queueIndex;
                    if (valuesAgree('queueIndex', qIdxHold.expected, incomingIdx)) {
                        delete holds.queueIndex;
                    } else if (now < qIdxHold.until) {
                        mirrored = { ...mirrored, queueIndex: qIdxHold.expected as number };
                    } else {
                        delete holds.queueIndex;
                    }
                }

                return { holds, mirrored };
            }),
        clearTarget: () =>
            set({
                holds: {},
                mirrored: emptyMirrored,
                ownerServerId: null,
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
                        // Finding 1: pin the advanced index so a stale poll that
                        // recomputes the old index can't bounce the highlight.
                        queueIndex: { expected: idx + 1, until: now + DEFAULT_HOLD_MS },
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
                        // Finding 1: pin the rewound index (see optimisticNext).
                        queueIndex: { expected: idx - 1, until: now + DEFAULT_HOLD_MS },
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
                    } else if (key === 'isMuted' && partial.isMuted !== undefined) {
                        holds.isMuted = { expected: partial.isMuted, until };
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
            set(
                active
                    ? {}
                    : {
                          // Drop the device list when the poller stops — by
                          // the time it restarts (server switch, sign-out,
                          // settings flip) those device ids belong to a
                          // different population. Letting them linger leaks
                          // last-server devices into the picker until the
                          // next tick lands.
                          //
                          // Finding 3: do NOT clear `holds` here. The poller hook
                          // tears the poller down on every isPickerOpen flip, so
                          // opening the device picker while connected used to wipe
                          // every in-flight optimistic hold (pause/seek/skip) —
                          // the exact snap-back the hold system prevents. Holds
                          // are only meaningful with a target, and `clearTarget`
                          // already resets them, so a genuine target teardown is
                          // still covered. Picker open/close no longer destroys
                          // holds.
                          deviceList: [],
                          hasPolledOnce: false,
                          pollError: null,
                      },
            ),
        setPollError: (error) => set({ pollError: error }),
        setStatus: (status) => set({ status }),
        setTarget: ({ capabilities, deviceId, deviceName, ownerServerId, sessionId }) =>
            set(() => ({
                holds: {},
                mirrored: { ...emptyMirrored, capabilities },
                ownerServerId: ownerServerId ?? null,
                sessionId,
                // Start in 'connecting' — the sessions sink/poller flips us to
                // 'connected' as soon as the target session is found in the
                // next /Sessions snapshot. This is the canonical first-mirror
                // signal the picker's connect-toast listens for.
                status: 'connecting',
                targetDeviceId: deviceId,
                targetDeviceName: deviceName,
            })),
    },
    deviceList: [],
    hasPolledOnce: false,
    holds: {},
    mirrored: emptyMirrored,
    ownerServerId: null,
    pickerOpen: false,
    pollError: null,
    sessionId: null,
    status: 'idle',
    targetDeviceId: null,
    targetDeviceName: null,
}));

// Re-export for tests / instrumentation.
export { valuesAgree };
