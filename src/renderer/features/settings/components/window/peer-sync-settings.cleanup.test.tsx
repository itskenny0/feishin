/**
 * Behavioural regression for the Jellyfin Remote master kill-switch.
 *
 * When the user flips "Enable Jellyfin Remote" off mid-session the wizard
 * promises "no device picker, no Sessions polling, no remote-control
 * receiver. MQTT is also paused since the picker is its entry point." That
 * means we have to actually clean up:
 *   - the live remote target (so the player stops trying to drive a device
 *     the picker can no longer reach)
 *   - the persisted target device id/name (so a fresh launch is also clean)
 *   - the embedded broker is stopped via the preload bridge (covered
 *     implicitly: no broker IPC in the renderer test env, so we just check
 *     the renderer-side bookkeeping flips correctly)
 */
import { MantineProvider } from '@mantine/core';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { PeerSyncSettings } from '/@/renderer/features/settings/components/window/peer-sync-settings';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seed = () => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            enabled: true,
            jellyfinRemoteEnabled: true,
            onboarded: true,
        },
        playback: {
            ...prev.playback,
            remoteTargetDeviceId: 'device-123',
            remoteTargetDeviceName: 'Living Room',
        },
    });
    useRemoteTargetStore.getState().actions.setTarget({
        capabilities: {} as never,
        deviceId: 'device-123',
        deviceName: 'Living Room',
        sessionId: 'sess-1',
    });
};

afterEach(() => {
    cleanup();
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('PeerSyncSettings master kill-switch', () => {
    it('clears the live remote target and persisted device id when flipped off', () => {
        seed();
        render(
            <MantineProvider>
                <PeerSyncSettings />
            </MantineProvider>,
        );

        // Sanity: precondition holds
        expect(useRemoteTargetStore.getState().targetDeviceId).toBe('device-123');
        expect(useSettingsStore.getState().playback.remoteTargetDeviceId).toBe('device-123');

        // The "Enable Jellyfin Remote" Switch is the first Switch in the
        // section; click it to toggle off.
        const masterSwitch = screen.getByRole('switch', {
            name: /enable jellyfin remote/i,
        });
        fireEvent.click(masterSwitch);

        // jellyfinRemoteEnabled flipped to false
        expect(useSettingsStore.getState().peerSync.jellyfinRemoteEnabled).toBe(false);
        // The live remote-target store was cleared
        expect(useRemoteTargetStore.getState().targetDeviceId).toBeNull();
        // The persisted remote device id was cleared too (so a reload starts
        // clean instead of trying to bind to a device behind a hidden picker)
        expect(useSettingsStore.getState().playback.remoteTargetDeviceId).toBeNull();
    });
});
