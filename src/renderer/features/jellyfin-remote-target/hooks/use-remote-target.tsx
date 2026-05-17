// src/renderer/features/jellyfin-remote-target/hooks/use-remote-target.tsx
import { useShallow } from 'zustand/react/shallow';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

export const useRemoteTarget = () =>
    useRemoteTargetStore(
        useShallow((s) => ({
            deviceId: s.targetDeviceId,
            deviceName: s.targetDeviceName,
            isRemote: s.targetDeviceId !== null,
            mirrored: s.mirrored,
            sessionId: s.sessionId,
            status: s.status,
        })),
    );
