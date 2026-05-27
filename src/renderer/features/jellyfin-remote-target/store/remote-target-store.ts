import type {
    RemoteDevice,
    RemoteMirrored,
    RemoteTargetStatus,
} from '/@/renderer/features/jellyfin-remote-target/types';

import { create } from 'zustand';

interface RemoteTargetState {
    actions: {
        clearTarget: () => void;
        reconcileSession: (session: {
            capabilities: string[];
            deviceName: string;
            sessionId: string;
        }) => void;
        setDeviceList: (devices: RemoteDevice[]) => void;
        setMirrored: (mirrored: Partial<RemoteMirrored>) => void;
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
        reconcileSession: ({ capabilities, deviceName, sessionId }) =>
            set((s) => ({
                mirrored: { ...s.mirrored, capabilities },
                sessionId,
                status: 'connected',
                targetDeviceName: deviceName,
            })),
        setDeviceList: (devices) => set({ deviceList: devices, hasPolledOnce: true }),
        setMirrored: (partial) => set((s) => ({ mirrored: { ...s.mirrored, ...partial } })),
        setPickerOpen: (open) => set({ pickerOpen: open }),
        setPollerActive: (active) => set(active ? {} : { hasPolledOnce: false, pollError: null }),
        setPollError: (error) => set({ pollError: error }),
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
    hasPolledOnce: false,
    mirrored: emptyMirrored,
    pickerOpen: false,
    pollError: null,
    sessionId: null,
    status: 'idle',
    targetDeviceId: null,
    targetDeviceName: null,
}));

export const useRemoteTargetActions = () => useRemoteTargetStore((s) => s.actions);
