import { create } from 'zustand';

import type {
    RemoteDevice,
    RemoteMirrored,
    RemoteTargetStatus,
} from '/@/renderer/features/jellyfin-remote-target/types';

interface RemoteTargetState {
    actions: {
        clearTarget: () => void;
        setDeviceList: (devices: RemoteDevice[]) => void;
        setMirrored: (mirrored: Partial<RemoteMirrored>) => void;
        setStatus: (status: RemoteTargetStatus) => void;
        setTarget: (target: { capabilities: string[]; deviceId: string; deviceName: string; sessionId: string }) => void;
    };
    deviceList: RemoteDevice[];
    mirrored: RemoteMirrored;
    sessionId: null | string;          // re-resolved each Sessions tick from targetDeviceId
    status: RemoteTargetStatus;
    targetDeviceId: null | string;
    targetDeviceName: null | string;
}

const emptyMirrored: RemoteMirrored = {
    capabilities: [],
    nowPlayingItem: null,
    playState: { isPaused: true, positionMs: 0, repeatMode: 'RepeatNone', volume: 100 },
    queue: [],
    queueIndex: -1,
};

export const useRemoteTargetStore = create<RemoteTargetState>((set) => ({
    actions: {
        clearTarget: () =>
            set({
                mirrored: emptyMirrored,
                sessionId: null,
                status: 'idle',
                targetDeviceId: null,
                targetDeviceName: null,
            }),
        setDeviceList: (devices) => set({ deviceList: devices }),
        setMirrored: (partial) =>
            set((s) => ({ mirrored: { ...s.mirrored, ...partial } })),
        setStatus: (status) => set({ status }),
        setTarget: ({ capabilities, deviceId, deviceName, sessionId }) =>
            set(() => ({
                mirrored: { ...emptyMirrored, capabilities },
                sessionId,
                status: 'connected',
                targetDeviceId: deviceId,
                targetDeviceName: deviceName,
            })),
    },
    deviceList: [],
    mirrored: emptyMirrored,
    sessionId: null,
    status: 'idle',
    targetDeviceId: null,
    targetDeviceName: null,
}));

export const useRemoteTargetActions = () => useRemoteTargetStore((s) => s.actions);
