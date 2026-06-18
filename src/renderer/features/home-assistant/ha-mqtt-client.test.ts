import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, handlers } = vi.hoisted(() => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const client = {
        connected: true,
        end: vi.fn(),
        on: vi.fn((ev: string, cb: any) => {
            handlers[ev] = cb;
            return client;
        }),
        publish: vi.fn((_t: string, _p: string, _o: any, cb?: (e?: Error) => void) => cb?.()),
        subscribe: vi.fn((_t: string, _o: any, cb?: (e?: Error) => void) => cb?.()),
    };
    return { client, handlers };
});

vi.mock('mqtt', () => ({ default: { connect: vi.fn(() => client) } }));

// Keep the peer-client import light: only the helpers ha-mqtt-client uses.
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    buildNativeTcpStreamBuilder: vi.fn(async () => null),
    normalizeBrokerUrl: (u: string) => u,
    resolveEffectiveTransport: () => 'ws',
}));

const stopPublisher = vi.fn();
vi.mock('./ha-state', () => ({ startHaStatePublisher: vi.fn(() => stopPublisher) }));
vi.mock('./ha-art', () => ({ startHaArtPublisher: vi.fn(() => vi.fn()) }));
vi.mock('./ha-commands', () => ({ applyHaCommand: vi.fn() }));

import { applyHaCommand } from './ha-commands';
import { isHaClientConnected, startHaClient, stopHaClient } from './ha-mqtt-client';

const args = {
    brokerUrl: 'ws://broker:8083',
    deviceName: 'X',
    peerId: 'p1',
    roomKey: 'k',
    userId: 'u1',
};

describe('ha-mqtt-client', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        client.connected = true;
        stopHaClient();
        vi.clearAllMocks();
    });

    it('on connect publishes availability + discovery and subscribes', () => {
        startHaClient(args);
        handlers.connect?.();
        const topics = client.publish.mock.calls.map((c) => c[0]);
        expect(topics).toContain('feishin/ha/feishin_p1/availability');
        expect(topics.some((t: string) => t.startsWith('homeassistant/sensor/feishin_p1/'))).toBe(
            true,
        );
        expect(client.subscribe).toHaveBeenCalledWith(
            'feishin/ha/feishin_p1/cmd/+',
            expect.anything(),
            expect.anything(),
        );
        expect(isHaClientConnected()).toBe(true);
    });

    it('routes inbound cmd topics to applyHaCommand', () => {
        startHaClient(args);
        handlers.connect?.();
        handlers.message?.('feishin/ha/feishin_p1/cmd/next', Buffer.from('PRESS'));
        expect(applyHaCommand).toHaveBeenCalledWith('next', 'PRESS');
    });

    it('stop clears discovery, goes offline, and ends the client', () => {
        startHaClient(args);
        handlers.connect?.();
        client.publish.mockClear();
        stopHaClient();
        const cleared = client.publish.mock.calls.filter(
            (c) => String(c[0]).startsWith('homeassistant/') && c[1] === '',
        );
        expect(cleared.length).toBeGreaterThan(0);
        const offline = client.publish.mock.calls.find(
            (c) => c[0] === 'feishin/ha/feishin_p1/availability' && c[1] === 'offline',
        );
        expect(offline).toBeTruthy();
        expect(client.end).toHaveBeenCalled();
        expect(stopPublisher).toHaveBeenCalled();
    });
});
