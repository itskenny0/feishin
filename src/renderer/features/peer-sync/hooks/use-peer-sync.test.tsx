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
const publishPresenceHeartbeat = vi.fn();
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    isPeerClientConnected: () => false,
    // The hook warms the lazy MQTT publish seam on boot
    // (peer-dispatcher.warmMqttPublish → dynamic import of this module), so the
    // mock must expose publishCommand or the warm rejects.
    publishCommand: () => {},
    publishPing: () => null,
    publishPresenceHeartbeat: () => publishPresenceHeartbeat(),
    startPeerClient: (...args: unknown[]) => startPeerClient(...args),
    stopPeerClient: () => stopPeerClient(),
}));

import {
    MQTT_PRESENCE_TTL_MS,
    pickTransport,
    recordPresence,
    __resetForTests as resetTransportSelector,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { PeerSyncHook } from '/@/renderer/features/peer-sync/hooks/use-peer-sync';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { useSettingsStore } from '/@/renderer/store/settings.store';

type PeerEventsArg = {
    onPong?: (from: { peerId: string; userId: string }, pong: unknown) => void;
};

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
            homeAssistant: { deviceName: '', enabled: false },
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

describe('usePeerSync pong → presence freshness (SEV-1)', () => {
    beforeEach(() => resetTransportSelector());
    afterEach(() => resetTransportSelector());

    it('an inbound pong refreshes the sender presence so the MQTT lane survives the TTL', () => {
        setSyncEnabled(true);
        const now = 2_000_000;
        // Selector knows the peer (seen a presence frame at t0).
        recordPresence('peer-remote', true, now);
        expect(pickTransport('peer-remote', now)).toBe('mqtt');

        seedServer('carol');
        seedPeerSync();
        render(<PeerSyncHook />);
        const events = startPeerClient.mock.calls[0][1] as PeerEventsArg;

        // A pong lands at TTL/2 — the hook's onPong must touchPresence so the
        // lane stays 'mqtt' past the original TTL boundary.
        const realNow = Date.now;
        try {
            (Date as unknown as { now: () => number }).now = () => now + MQTT_PRESENCE_TTL_MS / 2;
            events.onPong?.({ peerId: 'peer-remote', userId: 'user-1' }, {});
        } finally {
            (Date as unknown as { now: () => number }).now = realNow;
        }
        expect(pickTransport('peer-remote', now + MQTT_PRESENCE_TTL_MS + 1)).toBe('mqtt');
    });
});
