/**
 * Render coverage for the shared Jellyfin Connect device list.
 *
 * Focus areas (Sync & Connect audit):
 *   - F5: the "Hide devices without MQTT" filter and the empty-state message
 *     must be driven by the SAME filtered list, with a distinct message when
 *     the filter zeroes a non-empty list.
 *   - G5: the lane badge must react to a transport flip without a remount
 *     (the memo keys on the flip counter).
 *   - F8: rows expose listbox/option/aria-selected semantics.
 */
import type { RemoteDevice } from '/@/renderer/features/jellyfin-remote-target/types';

import { MantineProvider } from '@mantine/core';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DevicePickerList } from '/@/renderer/features/jellyfin-remote-target/components/device-picker-list';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import {
    recordPresence,
    __resetForTests as resetTransport,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

let deviceSeq = 0;
const makeDevice = (overrides: Partial<RemoteDevice> = {}): RemoteDevice => {
    deviceSeq += 1;
    return {
        capabilities: [],
        client: 'jellyfin-web',
        deviceId: `dev-${deviceSeq}`,
        deviceName: `Device ${deviceSeq}`,
        isPaused: false,
        lastActivityIso: new Date(2024, 0, deviceSeq).toISOString(),
        nowPlayingArtist: null,
        nowPlayingItemId: null,
        nowPlayingTitle: null,
        sessionId: `sess-${deviceSeq}`,
        supportsMediaControl: true,
        supportsRemoteControl: true,
        ...overrides,
    };
};

const setHideNonMqtt = (hide: boolean) => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            jellyfinRemoteEnabled: true,
            onboarded: true,
            ui: {
                ...prev.peerSync.ui,
                connectButton: true,
                hideNonMqttDevices: hide,
                pickerBadges: true,
                statusPill: true,
            },
        },
    });
};

const renderList = () =>
    render(
        <MantineProvider>
            <DevicePickerList onClose={() => {}} />
        </MantineProvider>,
    );

beforeEach(() => {
    deviceSeq = 0;
    resetTransport();
    // The local "This device" row is filtered out by ourDeviceId, so the
    // auth deviceId must not collide with any seeded dev-* id.
    useAuthStore.setState({ deviceId: 'our-local-device' });
    useRemoteTargetStore.getState().actions.clearTarget();
    setHideNonMqtt(false);
});

afterEach(() => {
    cleanup();
    resetTransport();
});

describe('DevicePickerList', () => {
    it('(a) filter off: shows every device row and no empty message', () => {
        const devices = [makeDevice(), makeDevice(), makeDevice()];
        act(() => useRemoteTargetStore.getState().actions.setDeviceList(devices));
        setHideNonMqtt(false);

        renderList();

        // The "This device" row plus N device rows.
        expect(screen.getAllByRole('option')).toHaveLength(devices.length + 1);
        expect(screen.queryByText(/No MQTT peers found/i)).toBeNull();
        for (const d of devices) {
            expect(screen.getByText(d.deviceName)).not.toBeNull();
        }
    });

    it('(b) filter on, all Jellyfin-only: zero rows + the noMqttPeers message', () => {
        const devices = [makeDevice(), makeDevice(), makeDevice()];
        act(() => useRemoteTargetStore.getState().actions.setDeviceList(devices));
        setHideNonMqtt(true);

        renderList();

        // Only the "This device" row survives the filter.
        expect(screen.getAllByRole('option')).toHaveLength(1);
        expect(screen.getByText(/No MQTT peers found/i)).not.toBeNull();
        expect(screen.getByText(/Turn off 'Hide devices without MQTT'/i)).not.toBeNull();
        // None of the Jellyfin-only device names rendered.
        for (const d of devices) {
            expect(screen.queryByText(d.deviceName)).toBeNull();
        }
    });

    it('(c) filter on, one device resolves to MQTT: that row shows, no empty message', () => {
        const mqttDevice = makeDevice({ deviceName: 'Living Room' });
        const jfDevice = makeDevice({ deviceName: 'Web Browser' });
        act(() => useRemoteTargetStore.getState().actions.setDeviceList([mqttDevice, jfDevice]));
        // Bridge the MQTT device's Jellyfin deviceId to a fresh online peer.
        setSyncEnabled(true);
        recordPresence('peer-1', true, Date.now(), mqttDevice.deviceId);
        setHideNonMqtt(true);

        renderList();

        expect(screen.getByText('Living Room')).not.toBeNull();
        expect(screen.queryByText('Web Browser')).toBeNull();
        expect(screen.queryByText(/No MQTT peers found/i)).toBeNull();
        // "This device" + the one surviving MQTT row.
        expect(screen.getAllByRole('option')).toHaveLength(2);
    });

    it('(d) filter on: the selected target stays visible even without MQTT', () => {
        const target = makeDevice({ deviceName: 'Selected TV' });
        const other = makeDevice({ deviceName: 'Other Web' });
        act(() => useRemoteTargetStore.getState().actions.setDeviceList([target, other]));
        act(() =>
            useRemoteTargetStore.getState().actions.setTarget({
                capabilities: [],
                deviceId: target.deviceId,
                deviceName: target.deviceName,
                sessionId: target.sessionId,
            }),
        );
        setHideNonMqtt(true);

        renderList();

        // The selected target bypasses the MQTT filter; the other does not.
        expect(screen.getByText('Selected TV')).not.toBeNull();
        expect(screen.queryByText('Other Web')).toBeNull();
        expect(screen.queryByText(/No MQTT peers found/i)).toBeNull();
    });

    it('(F8) exposes listbox/option roles and reflects the selected target via aria-selected', () => {
        const target = makeDevice({ deviceName: 'Active Device' });
        const other = makeDevice({ deviceName: 'Idle Device' });
        act(() => useRemoteTargetStore.getState().actions.setDeviceList([target, other]));
        act(() =>
            useRemoteTargetStore.getState().actions.setTarget({
                capabilities: [],
                deviceId: target.deviceId,
                deviceName: target.deviceName,
                sessionId: target.sessionId,
            }),
        );
        setHideNonMqtt(false);

        renderList();

        expect(screen.getByRole('listbox')).not.toBeNull();
        const selected = screen.getByText('Active Device').closest('[role="option"]');
        const unselected = screen.getByText('Idle Device').closest('[role="option"]');
        expect(selected?.getAttribute('aria-selected')).toBe('true');
        expect(unselected?.getAttribute('aria-selected')).toBe('false');
        // The local row is NOT selected while a remote target is active.
        const local = screen.getByText(/This device|This computer/i).closest('[role="option"]');
        expect(local?.getAttribute('aria-selected')).toBe('false');
    });

    it('(G5) lights the MQTT badge after a live transport flip without a remount', () => {
        const device = makeDevice({ deviceName: 'Bedroom Speaker' });
        act(() => useRemoteTargetStore.getState().actions.setDeviceList([device]));
        setSyncEnabled(true);
        setHideNonMqtt(false);

        renderList();

        // No badge yet — the device has no MQTT presence.
        expect(screen.queryByText('MQTT')).toBeNull();

        // A retained presence frame arrives, flipping the lane to MQTT. The
        // memo keys on the flip counter, so the badge appears with no remount.
        act(() => recordPresence('peer-1', true, Date.now(), device.deviceId));

        expect(screen.getByText('MQTT')).not.toBeNull();
    });
});
