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

/**
 * Metadata-only slice of the remote target — everything `useRemoteTarget`
 * exposes EXCEPT the `mirrored` payload. Consumers that only render a
 * label/spinner/active-state (transport pill, status banner, device-picker
 * buttons/list) should prefer this: `applyMirrorFromServer` allocates a fresh
 * `mirrored` object on every ~3s poll and every optimistic command, so
 * subscribing to the full object via `useRemoteTarget` re-renders those
 * metadata consumers on every tick even when none of the fields they show
 * changed. This slim selection only re-renders when an actual metadata field
 * (deviceId/deviceName/sessionId/status) flips.
 */
export const useRemoteTargetMeta = () =>
    useRemoteTargetStore(
        useShallow((s) => ({
            deviceId: s.targetDeviceId,
            deviceName: s.targetDeviceName,
            isRemote: s.targetDeviceId !== null,
            sessionId: s.sessionId,
            status: s.status,
        })),
    );
