// src/renderer/features/jellyfin-remote-target/hooks/use-remote-devices.tsx
import { useMemo } from 'react';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';
import { useAuthStore } from '/@/renderer/store/auth.store';

const compareDevices = (a: RemoteDevice, b: RemoteDevice) => {
    const aPlaying = a.nowPlayingItemId !== null ? 1 : 0;
    const bPlaying = b.nowPlayingItemId !== null ? 1 : 0;
    if (aPlaying !== bPlaying) return bPlaying - aPlaying;
    // Most-recently-active first
    return b.lastActivityIso.localeCompare(a.lastActivityIso);
};

export const useRemoteDevices = () => {
    const devices = useRemoteTargetStore((s) => s.deviceList);
    const ourDeviceId = useAuthStore((s) => s.deviceId);
    return useMemo(
        () =>
            devices
                .filter((d) => d.deviceId !== ourDeviceId)
                .filter((d) => d.supportsMediaControl)
                .slice()
                .sort(compareDevices),
        [devices, ourDeviceId],
    );
};
