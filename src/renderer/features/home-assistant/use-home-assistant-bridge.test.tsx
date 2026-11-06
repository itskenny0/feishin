/**
 * The HA bridge must authenticate exactly like the peer-sync client: against a
 * broker using the embedded scheme the password is the Jellyfin username (or
 * the room override), never the vestigial persisted `peerSync.roomKey`.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const startHaClient = vi.fn();
vi.mock('./ha-mqtt-client', () => ({
    startHaClient: (...args: unknown[]) => startHaClient(...args),
    stopHaClient: () => {},
}));

import { HomeAssistantHook } from './use-home-assistant-bridge';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seed = (peerSync: Record<string, unknown> = {}) => {
    useAuthStore.setState({
        ...useAuthStore.getState(),
        currentServer: {
            id: 'srv-1',
            type: 'jellyfin',
            userId: 'user-1',
            username: 'carol',
        } as never,
    });
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            ...prev.peerSync,
            brokerPassword: '',
            brokerUrl: 'ws://broker.lan:8083',
            brokerUsername: '',
            homeAssistant: { deviceName: 'Living Room', enabled: true },
            peerId: 'peer-xyz',
            roomKey: '',
            roomKeyOverride: '',
            ...peerSync,
        },
    });
};

beforeEach(() => startHaClient.mockClear());
afterEach(() => cleanup());

describe('useHomeAssistantBridge broker auth', () => {
    it('uses the Jellyfin username as the room key, ignoring the vestigial stored roomKey', () => {
        seed({ roomKey: 'stale-random-key' });
        render(<HomeAssistantHook />);
        expect(startHaClient).toHaveBeenCalledTimes(1);
        const args = startHaClient.mock.calls[0][0] as { roomKey: string; userId: string };
        expect(args.roomKey).toBe('carol');
        expect(args.userId).toBe('user-1');
    });

    it('a roomKeyOverride replaces both the namespace and the room key', () => {
        seed({ roomKeyOverride: ' family-room ' });
        render(<HomeAssistantHook />);
        const args = startHaClient.mock.calls[0][0] as { roomKey: string; userId: string };
        expect(args.roomKey).toBe('family-room');
        expect(args.userId).toBe('family-room');
    });
});
