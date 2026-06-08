// @vitest-environment node
/**
 * End-to-end verification of the embedded-broker connect fix.
 *
 * Reproduces the exact scenario that was broken: the embedded broker listens
 * on the wildcard host `0.0.0.0` (all interfaces), and the renderer client must
 * dial it on loopback. Before the fix the client had no URL at all (the wizard
 * persisted `brokerUrl: ''`); this test proves `resolveEmbeddedBrokerUrl` turns
 * the broker's own config into a URL a real mqtt.js client can CONNACK against
 * and round-trip a publish through — broker + client, no Electron, no network.
 *
 * The broker auth mirrors production (`src/main/.../peer-broker/index.ts`):
 * username = Jellyfin userId, password = room key, topics namespaced under
 * `feishin/v1/<userId>/`.
 */
import type { AuthErrorCode } from 'aedes';

import { Aedes } from 'aedes';
import { createServer } from 'http';
import mqtt from 'mqtt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebSocketStream, WebSocketServer } from 'ws';

import { resolveEmbeddedBrokerUrl } from './embedded-broker-url';

const ROOM_KEY = 'jellyfin-username';
const USER_ID = 'user-42';

interface Harness {
    aedes: Aedes;
    httpServer: ReturnType<typeof createServer>;
    port: number;
    wsServer: WebSocketServer;
}

// Bind to the wildcard host, exactly like the embedded broker's default
// (`host: '0.0.0.0'`), so we prove the helper's wildcard->loopback mapping is
// what lets the client actually reach it.
const startWildcardBroker = async (): Promise<Harness> => {
    const aedes = await Aedes.createBroker();
    aedes.authenticate = (client, username, password, cb) => {
        if (username && password && password.toString() === ROOM_KEY) {
            (client as unknown as Record<string, unknown>)._uid = username;
            cb(null, true);
            return;
        }
        const err = new Error('bad creds') as Error & { returnCode: AuthErrorCode };
        err.returnCode = 4 as AuthErrorCode;
        cb(err, false);
    };
    aedes.authorizePublish = (client, packet, cb) => {
        const uid = (client as unknown as Record<string, unknown>)._uid as string | undefined;
        const root = uid ? `feishin/v1/${uid}/` : '';
        cb(!root || !packet.topic.startsWith(root) ? new Error('publish denied') : null);
    };
    aedes.authorizeSubscribe = (client, sub, cb) => {
        const uid = (client as unknown as Record<string, unknown>)._uid as string | undefined;
        const root = uid ? `feishin/v1/${uid}/` : '';
        if (!root || !sub.topic.startsWith(root)) {
            cb(new Error('sub denied'), null);
            return;
        }
        cb(null, sub);
    };

    const httpServer = createServer();
    const wsServer = new WebSocketServer({ server: httpServer });
    wsServer.on('connection', (ws, req) => {
        const stream = createWebSocketStream(ws);
        aedes.handle(stream as unknown as Parameters<typeof aedes.handle>[0], req as never);
    });

    await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        // '0.0.0.0' == the embedded broker default listen host.
        httpServer.listen(0, '0.0.0.0', () => {
            httpServer.removeListener('error', reject);
            resolve();
        });
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('no listening address');
    return { aedes, httpServer, port: address.port, wsServer };
};

const stopHarness = async (h: Harness): Promise<void> => {
    await new Promise<void>((resolve) => h.wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => h.httpServer.close(() => resolve()));
    await new Promise<void>((resolve) => h.aedes.close(() => resolve()));
};

describe('embedded broker connect (helper-derived URL, wildcard-bound broker)', () => {
    let harness: Harness;

    beforeEach(async () => {
        harness = await startWildcardBroker();
    });

    afterEach(async () => {
        await stopHarness(harness);
    });

    it('connects via resolveEmbeddedBrokerUrl and round-trips a publish', async () => {
        // This is the production fix: derive the client URL from the SAME broker
        // config the broker was started with (host '0.0.0.0' -> loopback).
        const url = resolveEmbeddedBrokerUrl({ host: '0.0.0.0', port: harness.port });
        expect(url).toBe(`ws://127.0.0.1:${harness.port}`);

        const client = mqtt.connect(url!, {
            password: ROOM_KEY,
            protocolVersion: 4,
            reconnectPeriod: 0,
            username: USER_ID,
        });

        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(
                () => reject(new Error('CONNACK timeout — client never connected')),
                5_000,
            );
            client.once('connect', () => {
                clearTimeout(t);
                resolve();
            });
            client.once('error', (e) => {
                clearTimeout(t);
                reject(e);
            });
        });

        const topic = `feishin/v1/${USER_ID}/peer-self/cmd`;
        await new Promise<void>((resolve, reject) => {
            client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
        });

        const received: string[] = [];
        client.on('message', (_t, payload) => received.push(payload.toString()));
        client.publish(topic, 'play', { qos: 1 });

        await new Promise<void>((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                if (received.length > 0 || Date.now() - t0 > 3_000) return resolve();
                setTimeout(tick, 25);
            };
            tick();
        });

        expect(received).toEqual(['play']);
        await new Promise<void>((resolve) => client.end(true, undefined, () => resolve()));
    });
});
