import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useSessionsPoller } from '/@/renderer/features/jellyfin-remote-target/hooks/use-sessions-poller';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

const jellyfinServer: ServerListItemWithCredential = {
    credential: 'cred',
    id: 'srv-1',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'http://localhost',
    userId: 'user-1',
    username: 'demo',
};

// Stub the poller so the hook's start/stop side effects are observable
// without hitting the real /Sessions endpoint.
let startSpy: ReturnType<typeof vi.spyOn>;
let stopSpy: ReturnType<typeof vi.spyOn>;
let resetSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    startSpy = vi.spyOn(sessionsPoller, 'start').mockImplementation(() => {});
    stopSpy = vi.spyOn(sessionsPoller, 'stop').mockImplementation(() => {});
    resetSpy = vi.spyOn(sessionsSink, 'reset');
});

afterEach(() => {
    startSpy.mockRestore();
    stopSpy.mockRestore();
    resetSpy.mockRestore();
    useRemoteTargetStore.getState().actions.clearTarget();
    useRemoteTargetStore.setState({ pickerOpen: false });
    useAuthStore.setState({ currentServer: null });
    useSettingsStore.setState((s) => ({
        playback: {
            ...s.playback,
            remoteTargetDeviceId: null,
            remoteTargetDeviceName: null,
        },
    }));
});

describe('useSessionsPoller — bug 1: no auto-restore on launch', () => {
    it('does NOT engage the poller on mount even when a target device is persisted', () => {
        // Simulate: prior session persisted a Jellyfin device.
        useSettingsStore.setState((s) => ({
            playback: {
                ...s.playback,
                remoteTargetDeviceId: 'persisted-dev',
                remoteTargetDeviceName: 'Old Living Room',
            },
        }));
        useAuthStore.setState({ currentServer: jellyfinServer });

        // Mount the poller hook on a clean store (targetDeviceId === null,
        // pickerOpen === false).
        renderHook(() => useSessionsPoller());

        // Store must remain on local. The persisted setting is preserved
        // but never auto-applied.
        const state = useRemoteTargetStore.getState();
        expect(state.targetDeviceId).toBeNull();
        expect(state.targetDeviceName).toBeNull();
        expect(state.status).toBe('idle');
        // The persisted setting itself stays around for the picker's
        // "last connected" memory.
        expect(useSettingsStore.getState().playback.remoteTargetDeviceId).toBe('persisted-dev');
        // And critically — the poller stays stopped.
        expect(startSpy).not.toHaveBeenCalled();
    });

    it('engages the poller only after an explicit picker selection (setTarget)', () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        const { rerender } = renderHook(() => useSessionsPoller());
        expect(startSpy).not.toHaveBeenCalled();

        // User explicitly picks a device.
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        rerender();
        expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('engages the poller while the picker is open (so the device list can populate)', () => {
        useAuthStore.setState({ currentServer: jellyfinServer });
        const { rerender } = renderHook(() => useSessionsPoller());
        expect(startSpy).not.toHaveBeenCalled();

        useRemoteTargetStore.getState().actions.setPickerOpen(true);
        rerender();
        expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('stops the poller when no Jellyfin server is signed in', () => {
        useAuthStore.setState({ currentServer: null });
        renderHook(() => useSessionsPoller());
        expect(stopSpy).toHaveBeenCalled();
        expect(startSpy).not.toHaveBeenCalled();
    });
});

describe('useSessionsPoller — C4: sessions sink cache reset on server switch', () => {
    const serverA = jellyfinServer;
    const serverB: ServerListItemWithCredential = {
        ...jellyfinServer,
        id: 'srv-2',
        url: 'http://other',
    };

    it('resets the sink when the bound server id actually changes (A → B)', () => {
        useAuthStore.setState({ currentServer: serverA });
        useRemoteTargetStore.getState().actions.setPickerOpen(true);
        const { rerender } = renderHook(() => useSessionsPoller());
        // First mount binds server A — one reset for the initial bind.
        expect(resetSpy).toHaveBeenCalledTimes(1);

        // Switch to server B.
        useAuthStore.setState({ currentServer: serverB });
        rerender();
        // A real id change clears the per-device queue cache + backoff.
        expect(resetSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT reset on a same-id server object refresh (token / musicFolder update)', () => {
        useAuthStore.setState({ currentServer: serverA });
        useRemoteTargetStore.getState().actions.setPickerOpen(true);
        const { rerender } = renderHook(() => useSessionsPoller());
        expect(resetSpy).toHaveBeenCalledTimes(1);

        // updateServer replaces the currentServer object reference but keeps
        // the same id (e.g. a credential refresh). The cache must survive.
        useAuthStore.setState({
            currentServer: { ...serverA, credential: 'rotated-token' },
        });
        rerender();
        expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    it('resets on sign-out (server → null)', () => {
        useAuthStore.setState({ currentServer: serverA });
        useRemoteTargetStore.getState().actions.setPickerOpen(true);
        const { rerender } = renderHook(() => useSessionsPoller());
        expect(resetSpy).toHaveBeenCalledTimes(1);

        useAuthStore.setState({ currentServer: null });
        rerender();
        expect(resetSpy).toHaveBeenCalledTimes(2);
    });
});
