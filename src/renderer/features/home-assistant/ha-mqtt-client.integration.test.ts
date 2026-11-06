// @vitest-environment node
/**
 * Real broker round-trip for the HA bridge teardown: stopping the bridge must
 * actually clear the retained discovery configs (removing the device from
 * Home Assistant) and publish availability=offline - not just queue those
 * publishes on a stream that is destroyed in the same tick.
 */
import { Aedes } from 'aedes';
import { createServer } from 'http';
import mqtt from 'mqtt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebSocketStream, WebSocketServer } from 'ws';

vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    buildNativeTcpStreamBuilder: async () => null,
    normalizeBrokerUrl: (u: string) => u,
    resolveEffectiveTransport: () => 'ws',
}));
vi.mock('./ha-state', () => ({ startHaStatePublisher: () => () => {} }));
vi.mock('./ha-art', () => ({ startHaArtPublisher: () => () => {} }));
vi.mock('./ha-commands', () => ({ applyHaCommand: () => {} }));

import { isHaClientConnected, startHaClient, stopHaClient } from './ha-mqtt-client';

const waitFor = async (cond: () => boolean, ms = 3_000): Promise<void> => {
    const t0 = Date.now();
    while (!cond()) {
        if (Date.now() - t0 > ms) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
    }
};

describe('ha-mqtt-client against a real broker', () => {
    let aedes: Aedes;
    let httpServer: ReturnType<typeof createServer>;
    let wsServer: WebSocketServer;
    let url: string;
    let observer: mqtt.MqttClient | null = null;

    beforeEach(async () => {
        aedes = await Aedes.createBroker();
        httpServer = createServer();
        wsServer = new WebSocketServer({ server: httpServer });
        wsServer.on('connection', (ws, req) => {
            aedes.handle(createWebSocketStream(ws) as never, req as never);
        });
        await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
        const address = httpServer.address();
        if (!address || typeof address === 'string') throw new Error('no address');
        url = `ws://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        stopHaClient();
        observer?.end(true);
        observer = null;
        wsServer.clients.forEach((c) => c.terminate());
        await new Promise<void>((resolve) => wsServer.close(() => resolve()));
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        await new Promise<void>((resolve) => aedes.close(() => resolve()));
    });

    it('stop removes the retained discovery configs and marks the device offline', async () => {
        startHaClient({ brokerUrl: url, deviceName: 'X', peerId: 'p1', roomKey: '', userId: 'u' });
        await waitFor(isHaClientConnected);

        const retained = new Map<string, string>();
        const obs = mqtt.connect(url, { protocolVersion: 4, reconnectPeriod: 0 });
        observer = obs;
        obs.on('message', (topic, payload) => retained.set(topic, payload.toString()));
        await new Promise<void>((resolve) => obs.once('connect', () => resolve()));
        await new Promise<void>((resolve) =>
            obs.subscribe(['homeassistant/#', 'feishin/ha/#'], { qos: 1 }, () => resolve()),
        );
        await waitFor(() => retained.get('feishin/ha/feishin_p1/availability') === 'online');
        const discoveryTopics = [...retained.keys()].filter((t) => t.startsWith('homeassistant/'));
        expect(discoveryTopics.length).toBeGreaterThan(0);

        stopHaClient();
        await waitFor(() => retained.get('feishin/ha/feishin_p1/availability') === 'offline');
        await waitFor(() => discoveryTopics.every((t) => retained.get(t) === ''));
    });
});
