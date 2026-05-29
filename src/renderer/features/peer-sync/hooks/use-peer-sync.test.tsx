/**
 * use-peer-sync: the renderer lifecycle hook that boots the MQTT client.
 *
 * Pins the room-key contract: the broker auth password handed to
 * `startPeerClient` is the Jellyfin username (deterministic, shared across the
 * same account's devices), NOT the (now-vestigial) persisted random roomKey.
 * Also pins that the client does not boot without a signed-in username.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// is-electron → false so the embedded-broker status poller stays inert.
vi.mock('is-electron', () => ({ default: () => false }));

// Capture startPeerClient args. The other lifecycle deps run for real but are
// inert in jsdom (no real broker, timers cleaned up on unmount).
const startPeerClient = vi.fn();
const stopPeerClient = vi.fn();
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    isPeerClientConnected: () => false,
    publishPing: () => null,
    startPeerClient: (...args: unknown[]) => startPeerClient(...args),
    stopPeerClient: () => stopPeerClient(),
}));

import { PeerSyncHook } from '/@/renderer/features/peer-sync/hooks/use-peer-sync';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

const seedServer = (username: string | undefined) => {
    useAuthStore.setState({
        ...useAuthStore.getState(),
        currentServer: username
            ? ({
                  id: 'srv-1',
                  type: 'jellyfin',
                  userId: 'user-1',
                  username,
              } as never)
            : null,
    });
};

const seedPeerSync = (over: Record<string, unknown> = {}) => {
    const prev = useSettingsStore.getState();
    useSettingsStore.setState({
        ...prev,
        peerSync: {
            broker: { enabled: false, host: '0.0.0.0', port: 8083 },
            brokerPassword: '',
            brokerUrl: 'ws://broker.lan:8083',
            brokerUsername: '',
            enabled: true,
            jellyfinRemoteEnabled: true,
            onboarded: true,
            peerId: 'peer-xyz',
            roomKey: 'stale-random-key',
            transport: 'auto',
            ui: {
                connectButton: true,
                hideNonMqttDevices: false,
                pickerBadges: true,
                statusPill: true,
            },
            ...over,
        },
    });
};

beforeEach(() => {
    startPeerClient.mockClear();
    stopPeerClient.mockClear();
});
afterEach(() => cleanup());

describe('usePeerSync roomKey contract', () => {
    it('boots the client with roomKey = Jellyfin username, ignoring the stored roomKey', () => {
        seedServer('carol');
        seedPeerSync();
        render(<PeerSyncHook />);
        expect(startPeerClient).toHaveBeenCalledTimes(1);
        const args = startPeerClient.mock.calls[0][0] as { peerId: string; roomKey: string };
        expect(args.roomKey).toBe('carol');
        // It must NOT use the stale persisted random key.
        expect(args.roomKey).not.toBe('stale-random-key');
        expect(args.peerId).toBe('peer-xyz');
    });

    it('does not boot the client when no username is present', () => {
        seedServer(undefined);
        seedPeerSync();
        render(<PeerSyncHook />);
        expect(startPeerClient).not.toHaveBeenCalled();
    });
});
