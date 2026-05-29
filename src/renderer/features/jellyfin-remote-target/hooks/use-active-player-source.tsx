import type { Song } from '/@/shared/types/domain-types';

// src/renderer/features/jellyfin-remote-target/hooks/use-active-player-source.tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';

import {
    interpolatePositionMs,
    jellyfinToPlayerRepeat,
    jellyfinToPlayerShuffle,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import {
    usePlayerRepeat,
    usePlayerShuffle,
    usePlayerSong,
    usePlayerStatus,
    usePlayerVolume,
} from '/@/renderer/store/player.store';
import { PlayerRepeat, PlayerShuffle, PlayerStatus } from '/@/shared/types/types';

export interface ActivePlayerSource {
    capabilities: string[]; // empty in local mode
    deviceName: null | string; // null in local mode
    isPaused: boolean;
    mode: PlayerSourceMode;
    nowPlayingItem: null | Song;
    positionMs: number;
    queue: null | Song[]; // null = use local queue store
    queueIndex: number; // -1 if unknown
    volume: number;
}

export type PlayerSourceMode = 'local' | 'remote';

export const useActivePlayerSource = (): ActivePlayerSource => {
    // Subscribe to the specific mirrored leaves this hook surfaces (via a
    // shallow-equality selection) rather than the whole `mirrored` object.
    // applyMirrorFromServer only re-spreads `playState` and the outer object,
    // so leaf references (capabilities/nowPlayingItem/queue) stay stable
    // across polls that don't touch them — the shallow compare then holds and
    // the memo below doesn't invalidate every ~3s tick.
    const remote = useRemoteTargetStore(
        useShallow((s) => ({
            capabilities: s.mirrored.capabilities,
            deviceName: s.targetDeviceName,
            isPaused: s.mirrored.playState.isPaused,
            isRemote: s.targetDeviceId !== null,
            nowPlayingItem: s.mirrored.nowPlayingItem,
            positionMs: s.mirrored.playState.positionMs,
            queue: s.mirrored.queue,
            queueIndex: s.mirrored.queueIndex,
            volume: s.mirrored.playState.volume,
        })),
    );
    const localSong = usePlayerSong();
    const localStatus = usePlayerStatus();
    const localVolume = usePlayerVolume();

    return useMemo<ActivePlayerSource>(() => {
        if (remote.isRemote) {
            return {
                capabilities: remote.capabilities,
                deviceName: remote.deviceName,
                isPaused: remote.isPaused,
                mode: 'remote',
                nowPlayingItem: remote.nowPlayingItem,
                positionMs: remote.positionMs,
                queue: remote.queue,
                queueIndex: remote.queueIndex,
                volume: remote.volume,
            };
        }
        return {
            capabilities: [],
            deviceName: null,
            isPaused: localStatus !== PlayerStatus.PLAYING,
            mode: 'local',
            nowPlayingItem: (localSong as null | Song) ?? null,
            positionMs: 0, // playerbar reads local position via its own slider hook
            queue: null, // null = use existing local queue selectors
            queueIndex: -1,
            volume: localVolume,
        };
    }, [remote, localSong, localStatus, localVolume]);
};

/**
 * Playstate transport commands. These travel over POST /Sessions/{id}/Playing/*
 * and are available on ANY session that accepts media control — they are NOT
 * listed in a session's `SupportedCommands` (that list only enumerates
 * GeneralCommand types like SetVolume/SetRepeatMode). Gating these on
 * SupportedCommands wrongly greys out play/pause/next/prev/seek for every
 * remote target, so they're always enabled in remote mode.
 */
const PLAYSTATE_TRANSPORT = new Set([
    'FastForward',
    'NextTrack',
    'PlayPause',
    'PreviousTrack',
    'Rewind',
    'Seek',
    'Stop',
]);

/**
 * Whether a given transport capability is available on the active player.
 * Local mode: everything is enabled. Remote mode: Playstate transport is
 * always available; GeneralCommand-backed controls (SetVolume, Mute,
 * SetRepeatMode, SetShuffleQueue, …) are gated on the target's advertised
 * `SupportedCommands`.
 *
 * Subscribes to a primitive only — the boolean answer itself — so this is
 * cheap to call from every transport button.
 */
export const useTransportEnabled = (capability: string): boolean => {
    return useRemoteTargetStore((s) => {
        if (s.targetDeviceId === null) return true;
        if (PLAYSTATE_TRANSPORT.has(capability)) return true;
        return s.mirrored.capabilities.includes(capability);
    });
};

/**
 * Just the now-playing track of the active source — local song when no
 * remote target is set, the mirrored remote song otherwise. Subscribes only
 * to the relevant slice so consumers don't re-render on every position
 * tick or volume change.
 */
export const useActiveNowPlayingItem = (): null | Song => {
    const localSong = usePlayerSong();
    const remoteSong = useRemoteTargetStore((s) =>
        s.targetDeviceId === null ? null : s.mirrored.nowPlayingItem,
    );
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    return isRemote ? remoteSong : ((localSong as null | Song) ?? null);
};

/**
 * Combined pause state for the active source. In remote mode, mirrors the
 * remote device's PlayState.IsPaused; in local mode, derives from the local
 * player status. Primitive boolean — components only re-render on flip.
 */
export const useActiveIsPaused = (): boolean => {
    const localStatus = usePlayerStatus();
    const remoteIsPaused = useRemoteTargetStore((s) =>
        s.targetDeviceId === null ? false : s.mirrored.playState.isPaused,
    );
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    return isRemote ? remoteIsPaused : localStatus !== PlayerStatus.PLAYING;
};

/**
 * Minimum interval between React state writes from the rAF interpolation
 * loop. ~20fps (50ms) is smooth enough for a seek bar whose minimum visible
 * step is one second, while cutting the per-frame setState pressure (and the
 * downstream reconciliation of every position consumer) by ~3x versus the
 * native ~60Hz rAF cadence.
 */
const POSITION_EMIT_INTERVAL_MS = 50;

/**
 * Remote playback position in ms, interpolated at animation framerate so the
 * seek bar advances smoothly between the 3s /Sessions polls — but the React
 * state write is throttled to ~20fps (see POSITION_EMIT_INTERVAL_MS) so the
 * consuming subtrees don't reconcile on every animation frame. Returns 0 when
 * no remote target is active.
 */
export const useRemoteInterpolatedPositionMs = (): number => {
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const playState = useRemoteTargetStore((s) => s.mirrored.playState);
    const durationMs = useRemoteTargetStore((s) => s.mirrored.nowPlayingItem?.duration);
    const [posMs, setPosMs] = useState(0);
    const frame = useRef<null | number>(null);
    const lastEmit = useRef(0);
    const lastValue = useRef<null | number>(null);

    useEffect(() => {
        if (!isRemote) {
            setPosMs(0);
            lastEmit.current = 0;
            lastValue.current = null;
            return;
        }
        const emit = (now: number, force: boolean) => {
            const next = interpolatePositionMs(playState, now, durationMs ?? undefined);
            // Gate to ~20fps AND to a changed integer ms so sub-pixel no-op
            // updates don't re-render the (heavy) position subtrees. `force`
            // bypasses the throttle for the immediate first paint after a
            // mirror change so the readout never lags a frame behind a seek.
            const rounded = Math.round(next);
            if (
                force ||
                (now - lastEmit.current >= POSITION_EMIT_INTERVAL_MS &&
                    rounded !== lastValue.current)
            ) {
                lastEmit.current = now;
                lastValue.current = rounded;
                setPosMs(next);
            }
        };
        const tick = () => {
            emit(Date.now(), false);
            if (!playState.isPaused) {
                frame.current = requestAnimationFrame(tick);
            }
        };
        // First paint after a mirror change is forced so a pause/seek snaps
        // immediately; subsequent frames are throttled.
        emit(Date.now(), true);
        if (!playState.isPaused) {
            frame.current = requestAnimationFrame(tick);
        }
        return () => {
            if (frame.current !== null) cancelAnimationFrame(frame.current);
            frame.current = null;
        };
    }, [isRemote, playState, durationMs]);

    return posMs;
};

/**
 * Repeat mode of the active source — the remote device's mirrored RepeatMode
 * when a Connect target is active, else the local player's. Primitive enum so
 * the repeat button only re-renders on change.
 */
export const useActiveRepeat = (): PlayerRepeat => {
    const localRepeat = usePlayerRepeat();
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const remoteRepeat = useRemoteTargetStore((s) => s.mirrored.playState.repeatMode);
    return isRemote ? jellyfinToPlayerRepeat(remoteRepeat) : localRepeat;
};

/**
 * Shuffle state of the active source — the remote device's mirrored
 * PlaybackOrder when a Connect target is active, else the local player's.
 */
export const useActiveShuffle = (): PlayerShuffle => {
    const localShuffle = usePlayerShuffle();
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const remoteShuffle = useRemoteTargetStore((s) => s.mirrored.playState.shuffle);
    return isRemote ? jellyfinToPlayerShuffle(remoteShuffle) : localShuffle;
};
