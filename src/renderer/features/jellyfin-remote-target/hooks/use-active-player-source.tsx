import type { Song } from '/@/shared/types/domain-types';

// src/renderer/features/jellyfin-remote-target/hooks/use-active-player-source.tsx
import { useEffect, useMemo, useRef, useState } from 'react';

import {
    interpolatePositionMs,
    jellyfinToPlayerRepeat,
    jellyfinToPlayerShuffle,
} from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
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
    const remote = useRemoteTarget();
    const localSong = usePlayerSong();
    const localStatus = usePlayerStatus();
    const localVolume = usePlayerVolume();

    return useMemo<ActivePlayerSource>(() => {
        if (remote.isRemote) {
            return {
                capabilities: remote.mirrored.capabilities,
                deviceName: remote.deviceName,
                isPaused: remote.mirrored.playState.isPaused,
                mode: 'remote',
                nowPlayingItem: remote.mirrored.nowPlayingItem,
                positionMs: remote.mirrored.playState.positionMs,
                queue: remote.mirrored.queue,
                queueIndex: remote.mirrored.queueIndex,
                volume: remote.mirrored.playState.volume,
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
 * Whether a given transport capability is available on the active player.
 *
 * Subscribes to a primitive only — the boolean answer itself — so this is
 * cheap to call from every transport button without dragging the full
 * useActivePlayerSource (now-playing item, queue, position, volume) into
 * each button's render path.
 */
export const useTransportEnabled = (capability: string): boolean => {
    return useRemoteTargetStore((s) => {
        if (s.targetDeviceId === null) return true;
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
 * Remote playback position in ms, interpolated at animation framerate so the
 * seek bar advances smoothly between the 3s /Sessions polls. Returns 0 when no
 * remote target is active.
 */
export const useRemoteInterpolatedPositionMs = (): number => {
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const playState = useRemoteTargetStore((s) => s.mirrored.playState);
    const durationMs = useRemoteTargetStore((s) => s.mirrored.nowPlayingItem?.duration);
    const [posMs, setPosMs] = useState(0);
    const frame = useRef<null | number>(null);

    useEffect(() => {
        if (!isRemote) {
            setPosMs(0);
            return;
        }
        const tick = () => {
            setPosMs(interpolatePositionMs(playState, Date.now(), durationMs ?? undefined));
            if (!playState.isPaused) {
                frame.current = requestAnimationFrame(tick);
            }
        };
        tick();
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
