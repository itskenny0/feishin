/**
 * Unit tests for the native Jellyfin /Sessions push channel.
 *
 * What this covers:
 *  - Reconnect backoff math (locked-down: 1, 2, 4, 8, 16, 30, 30, ...).
 *  - Build the wss/ws URL with api_key + deviceId from the auth store.
 *  - Inbound `Sessions` envelope routes its Data array to the callback.
 *  - Non-`Sessions` messages (`KeepAlive`, `ForceKeepAlive`, garbage) don't
 *    fire the callback.
 *  - A `Sessions` frame received through the socket path produces the SAME
 *    store update as the identical payload applied through the poll path,
 *    i.e. both feed `sessionsSink.apply()` and the two transports are
 *    interchangeable from the store's perspective.
 *  - On socket open we send a SessionsStart subscribe frame.
 */
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    buildSocketUrl,
    reconnectDelayMs,
    SessionsSocket,
} from '/@/renderer/features/jellyfin-remote-target/controller/sessions-socket';
import { useAuthStore } from '/@/renderer/store/auth.store';
import { ServerType } from '/@/shared/types/domain-types';

const server: ServerListItemWithCredential = {
    credential: 'tok-abc',
    id: 'srv-1',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'https://demo.example/',
    userId: 'user-1',
    username: 'demo',
};

/**
 * Minimal controllable WebSocket stand-in. The real browser/Node WebSocket
 * can't be opened against a localhost-only URL during unit tests, so we
 * install this on `globalThis.WebSocket` and drive lifecycle transitions
 * synchronously from the test body.
 */
class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static OPEN = 1;

    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((ev: { type: string }) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onopen: (() => void) | null = null;

    readyState = 0;
    sent: string[] = [];

    constructor(public url: string) {
        MockWebSocket.instances.push(this);
    }

    close(): void {
        this.readyState = 3;
        this.onclose?.({ code: 1000, reason: '', wasClean: true });
    }

    send(data: string): void {
        this.sent.push(data);
    }

    triggerClose(opts: Partial<{ code: number; reason: string; wasClean: boolean }> = {}): void {
        this.readyState = 3;
        this.onclose?.({
            code: opts.code ?? 1006,
            reason: opts.reason ?? '',
            wasClean: opts.wasClean ?? false,
        });
    }

    triggerMessage(data: unknown): void {
        this.onmessage?.({ data });
    }

    triggerOpen(): void {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.();
    }
}

const installMockWS = () => {
    MockWebSocket.instances = [];
    // Vitest's jsdom environment installs a stub WebSocket that throws on
    // construction. Override it for the lifetime of each test.
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
        MockWebSocket as unknown as typeof WebSocket;
};

describe('reconnectDelayMs', () => {
    // Full-jitter: each value is the ceiling * (0.5 + rng * 0.5), so the
    // computed delay lands in [ceiling/2, ceiling]. The tests seed `rng` via
    // the optional second arg so behaviour is deterministic.

    it('starts in [0.5s, 1s] on the first attempt', () => {
        expect(reconnectDelayMs(0, () => 0)).toBe(500);
        expect(reconnectDelayMs(0, () => 1)).toBe(1_000);
        expect(reconnectDelayMs(0, () => 0.5)).toBe(750);
    });

    it('doubles the ceiling each attempt: 2s, 4s, 8s, 16s with jitter floor at half', () => {
        expect(reconnectDelayMs(1, () => 1)).toBe(2_000);
        expect(reconnectDelayMs(1, () => 0)).toBe(1_000);
        expect(reconnectDelayMs(2, () => 1)).toBe(4_000);
        expect(reconnectDelayMs(2, () => 0)).toBe(2_000);
        expect(reconnectDelayMs(3, () => 1)).toBe(8_000);
        expect(reconnectDelayMs(4, () => 1)).toBe(16_000);
    });

    it('caps the ceiling at 30s once the doubled value would exceed it', () => {
        // 2^5 * 1000 = 32_000 → clipped to 30_000 before jitter.
        expect(reconnectDelayMs(5, () => 1)).toBe(30_000);
        expect(reconnectDelayMs(6, () => 1)).toBe(30_000);
        expect(reconnectDelayMs(20, () => 1)).toBe(30_000);
        // Even at the jitter floor, attempt >=5 stays at >=15s.
        expect(reconnectDelayMs(5, () => 0)).toBe(15_000);
    });

    it('with the real Math.random, every sampled delay is within [ceiling/2, ceiling]', () => {
        // Spot-check the live behaviour without seeding the rng.
        for (let i = 0; i < 50; i++) {
            const d = reconnectDelayMs(2);
            expect(d).toBeGreaterThanOrEqual(2_000);
            expect(d).toBeLessThanOrEqual(4_000);
        }
    });
});

describe('buildSocketUrl', () => {
    it('turns https into wss and appends /socket with api_key + deviceId', () => {
        const url = buildSocketUrl(server, 'dev-xyz');
        expect(url).not.toBeNull();
        const parsed = new URL(url as string);
        expect(parsed.protocol).toBe('wss:');
        expect(parsed.pathname).toBe('/socket');
        expect(parsed.searchParams.get('api_key')).toBe('tok-abc');
        expect(parsed.searchParams.get('deviceId')).toBe('dev-xyz');
    });

    it('turns http into ws', () => {
        const url = buildSocketUrl({ ...server, url: 'http://demo.local:8096' }, 'dev-1');
        expect(url).not.toBeNull();
        const parsed = new URL(url as string);
        expect(parsed.protocol).toBe('ws:');
        expect(parsed.host).toBe('demo.local:8096');
    });

    it('returns null on a malformed url', () => {
        const url = buildSocketUrl({ ...server, url: 'not a url' }, 'dev-1');
        expect(url).toBeNull();
    });
});

describe('SessionsSocket inbound parsing', () => {
    beforeEach(() => {
        installMockWS();
        useAuthStore.setState({ deviceId: 'unit-device' });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('routes a `Sessions` frame to the onSessionsFrame callback', () => {
        const onSessionsFrame = vi.fn();
        const sock = new SessionsSocket({ onSessionsFrame, server });
        sock.start();

        const ws = MockWebSocket.instances[0];
        expect(ws).toBeTruthy();
        ws.triggerOpen();

        ws.triggerMessage(
            JSON.stringify({
                Data: [
                    { DeviceId: 'd1', DeviceName: 'Living Room', Id: 's1' },
                    { DeviceId: 'd2', DeviceName: 'Kitchen', Id: 's2' },
                ],
                MessageType: 'Sessions',
            }),
        );

        expect(onSessionsFrame).toHaveBeenCalledTimes(1);
        const rows = onSessionsFrame.mock.calls[0][0] as unknown[];
        expect(rows).toHaveLength(2);
        sock.stop();
    });

    it('sends a SessionsStart subscribe on open', () => {
        const onSessionsFrame = vi.fn();
        const sock = new SessionsSocket({ onSessionsFrame, server });
        sock.start();
        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        const subscribe = ws.sent.find((s) => s.includes('SessionsStart'));
        expect(subscribe).toBeTruthy();
        const parsed = JSON.parse(subscribe as string);
        expect(parsed.MessageType).toBe('SessionsStart');
        expect(typeof parsed.Data).toBe('string');
        // Format is `<initialDelayMs>,<periodMs>`.
        expect(parsed.Data).toMatch(/^\d+,\d+$/);
        sock.stop();
    });

    it('ignores KeepAlive / ForceKeepAlive / garbage', () => {
        const onSessionsFrame = vi.fn();
        const sock = new SessionsSocket({ onSessionsFrame, server });
        sock.start();
        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();

        ws.triggerMessage(JSON.stringify({ MessageType: 'KeepAlive' }));
        ws.triggerMessage(JSON.stringify({ Data: 30, MessageType: 'ForceKeepAlive' }));
        ws.triggerMessage('not json');
        ws.triggerMessage(JSON.stringify({ Data: [{ Id: 'x' }] })); // missing MessageType
        ws.triggerMessage(123);

        expect(onSessionsFrame).not.toHaveBeenCalled();
        sock.stop();
    });

    it('drops a Sessions frame whose Data is not an array', () => {
        const onSessionsFrame = vi.fn();
        const sock = new SessionsSocket({ onSessionsFrame, server });
        sock.start();
        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();

        // Some forks have been seen emitting bare objects here. Defensive
        // code must not call the consumer with non-array Data.
        ws.triggerMessage(JSON.stringify({ Data: { not: 'an array' }, MessageType: 'Sessions' }));
        expect(onSessionsFrame).toHaveBeenCalledTimes(1);
        expect(onSessionsFrame.mock.calls[0][0]).toEqual([]);
        sock.stop();
    });

    it('emits state transitions: connecting → connected → closed on stop()', () => {
        const states: string[] = [];
        const sock = new SessionsSocket({
            onSessionsFrame: () => {},
            onStateChange: (s) => states.push(s),
            server,
        });
        sock.start();
        expect(states).toContain('connecting');

        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        expect(states).toContain('connected');

        sock.stop();
        expect(states[states.length - 1]).toBe('closed');
    });

    it('does not bounce when stop() is called before open()', () => {
        const sock = new SessionsSocket({ onSessionsFrame: () => {}, server });
        sock.start();
        sock.stop();
        // No new WS instance should be created after stop(). One construction
        // attempt is fine, but no reconnect should be scheduled.
        expect(MockWebSocket.instances).toHaveLength(1);
        expect(sock.getState()).toBe('closed');
    });

    it('detaches handlers on stop() so a late buffered frame neither fires the callback nor arms a timer (C1/C6)', () => {
        vi.useFakeTimers();
        const onSessionsFrame = vi.fn();
        const sock = new SessionsSocket({ onSessionsFrame, server });
        sock.start();
        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();

        // Teardown (e.g. a server switch). Per spec close() is async and a
        // buffered Sessions frame can still dispatch while CLOSING.
        sock.stop();

        // Handlers must be detached — onmessage is null after stop().
        expect(ws.onmessage).toBeNull();
        expect(ws.onclose).toBeNull();

        // Even if a stray frame is forced through, the guard must drop it:
        // no store poisoning, no re-armed liveness timer.
        sock['handleMessage'](
            ws as unknown as WebSocket,
            JSON.stringify({
                Data: [{ DeviceId: 'd1', DeviceName: 'Stale', Id: 's1' }],
                MessageType: 'Sessions',
            }),
        );
        expect(onSessionsFrame).not.toHaveBeenCalled();

        // Advance well past the 30s liveness timeout — no reconnect must be
        // scheduled (no new MockWebSocket constructed).
        vi.advanceTimersByTime(31_000);
        expect(MockWebSocket.instances).toHaveLength(1);
        expect(sock.getState()).toBe('closed');
        vi.useRealTimers();
    });

    it('ignores a frame from a previous socket while a new connection is in flight (C6 identity guard)', () => {
        const onSessionsFrame = vi.fn();
        const sock = new SessionsSocket({ onSessionsFrame, server });
        sock.start();
        const wsA = MockWebSocket.instances[0];
        wsA.triggerOpen();

        // Simulate a liveness-timeout-style reconnect: stop the live socket
        // and spin up a fresh connection (socket B). We drive this via a
        // direct start() after stop() to get a second MockWebSocket without
        // depending on timer internals.
        sock.stop();
        sock.start();
        const wsB = MockWebSocket.instances[1];
        expect(wsB).toBeTruthy();
        wsB.triggerOpen();

        // A frame delivered on the OLD socket A must be ignored: A is no
        // longer this.socket, so handleMessage's identity guard drops it.
        sock['handleMessage'](
            wsA as unknown as WebSocket,
            JSON.stringify({
                Data: [{ DeviceId: 'old', DeviceName: 'Old', Id: 'old' }],
                MessageType: 'Sessions',
            }),
        );
        expect(onSessionsFrame).not.toHaveBeenCalled();

        // A frame on the LIVE socket B is processed normally.
        wsB.triggerMessage(
            JSON.stringify({
                Data: [{ DeviceId: 'new', DeviceName: 'New', Id: 'new' }],
                MessageType: 'Sessions',
            }),
        );
        expect(onSessionsFrame).toHaveBeenCalledTimes(1);
        sock.stop();
    });
});

import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

describe('socket path ⇄ poll path equivalence', () => {
    beforeEach(() => {
        installMockWS();
        useAuthStore.setState({ deviceId: 'unit-device' });
        useRemoteTargetStore.getState().actions.clearTarget();
        useRemoteTargetStore.setState({ deviceList: [] });
        sessionsSink.reset();
    });

    afterEach(() => {
        useRemoteTargetStore.getState().actions.clearTarget();
        useRemoteTargetStore.setState({ deviceList: [] });
        sessionsSink.reset();
    });

    /**
     * Both transports feed `sessionsSink.apply()`. This test proves the
     * push path's frame, after extraction from the WS envelope, produces the
     * same store state as a poll-style direct call to the sink.
     */
    it('a Sessions WS frame and the equivalent poll-style apply produce the same deviceList', () => {
        const row = {
            Capabilities: { SupportsMediaControl: true },
            Client: 'Jellyfin Web',
            DeviceId: 'dev-xyz',
            DeviceName: 'Living Room',
            Id: 'sess-xyz',
            LastActivityDate: '2024-01-01T00:00:00Z',
            NowPlayingItem: null,
            PlayState: { IsPaused: false, PositionTicks: 0, VolumeLevel: 60 },
            SupportedCommands: ['SetVolume'],
            SupportsMediaControl: true,
            SupportsRemoteControl: true,
        };

        // --- Poll path baseline ---
        sessionsSink.apply([row], server);
        const pollDeviceList = useRemoteTargetStore.getState().deviceList;
        expect(pollDeviceList).toHaveLength(1);
        expect(pollDeviceList[0].deviceId).toBe('dev-xyz');
        expect(pollDeviceList[0].sessionId).toBe('sess-xyz');

        // Reset and replay through the socket path.
        useRemoteTargetStore.setState({ deviceList: [] });
        sessionsSink.reset();

        const sock = new SessionsSocket({
            onSessionsFrame: (rows) => sessionsSink.apply(rows, server),
            server,
        });
        sock.start();
        const ws = MockWebSocket.instances[0];
        ws.triggerOpen();
        ws.triggerMessage(JSON.stringify({ Data: [row], MessageType: 'Sessions' }));

        const socketDeviceList = useRemoteTargetStore.getState().deviceList;
        expect(socketDeviceList).toEqual(pollDeviceList);

        sock.stop();
    });

    /**
     * Server-switch race (C1): a Sessions frame is buffered on server A's
     * socket; the hook tears it down (stop) and re-binds server B. The buffered
     * A frame must NOT land in the store after stop() — the detached handler +
     * the stopped/identity guard drop it, so server B's device list stays
     * authoritative rather than being clobbered by server A's sessions.
     */
    it('a buffered server-A frame delivered after stop() does not clobber server-B device list', () => {
        const serverB: ServerListItemWithCredential = {
            ...server,
            id: 'srv-2',
            url: 'https://b.example/',
        };

        const sockA = new SessionsSocket({
            onSessionsFrame: (rows) => sessionsSink.apply(rows, server),
            server,
        });
        sockA.start();
        const wsA = MockWebSocket.instances[0];
        wsA.triggerOpen();

        // Effect cleanup on server switch tears down socket A.
        sockA.stop();

        // Server B's lane fetches its own sessions.
        sessionsSink.apply(
            [
                {
                    DeviceId: 'dev-B',
                    DeviceName: 'B Living Room',
                    Id: 'sess-B',
                    NowPlayingItem: null,
                    PlayState: { IsPaused: false, PositionTicks: 0, VolumeLevel: 50 },
                    SupportsMediaControl: true,
                    SupportsRemoteControl: true,
                },
            ],
            serverB,
        );
        expect(useRemoteTargetStore.getState().deviceList[0].deviceId).toBe('dev-B');

        // Server A's buffered frame finally dispatches on the dead socket.
        wsA.triggerMessage(
            JSON.stringify({
                Data: [
                    {
                        DeviceId: 'dev-A',
                        DeviceName: 'A Kitchen',
                        Id: 'sess-A',
                        NowPlayingItem: null,
                        PlayState: { IsPaused: false, PositionTicks: 0, VolumeLevel: 50 },
                        SupportsMediaControl: true,
                        SupportsRemoteControl: true,
                    },
                ],
                MessageType: 'Sessions',
            }),
        );

        // The store must still reflect server B — A's frame was dropped.
        const list = useRemoteTargetStore.getState().deviceList;
        expect(list).toHaveLength(1);
        expect(list[0].deviceId).toBe('dev-B');
    });
});
