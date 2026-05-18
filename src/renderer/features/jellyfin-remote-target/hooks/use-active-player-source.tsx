import type { Song } from '/@/shared/types/domain-types';

// src/renderer/features/jellyfin-remote-target/hooks/use-active-player-source.tsx
import { useMemo } from 'react';

import { useRemoteTarget } from '/@/renderer/features/jellyfin-remote-target/hooks/use-remote-target';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { usePlayerSong, usePlayerStatus, usePlayerVolume } from '/@/renderer/store/player.store';
import { PlayerStatus } from '/@/shared/types/types';

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
