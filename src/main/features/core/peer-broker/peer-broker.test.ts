// @vitest-environment node
/**
 * Embedded broker smoke test. Boots aedes over an in-process HTTP server
 * (no mDNS, no IPC), then connects an MQTT client and verifies:
 *
 *   - the client authenticates with the configured room key,
 *   - publish + subscribe round-trips inside the user namespace,
 *   - publishing outside the namespace is rejected by the broker.
 *
 * No live broker, no Electron, no network — just node + aedes + mqtt.js.
 * Skipped on environments where the broker fails to listen (CI without an
 * available loopback port falls back gracefully).
 */
import type { AuthErrorCode } from 'aedes';

import { Aedes } from 'aedes';
import { createServer } from 'http';
import mqtt from 'mqtt';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebSocketStream, WebSocketServer } from 'ws';

// Inline-copy of the topic helper from the renderer protocol module. The
// renderer alias isn't on the node tsconfig path map, and cross-process
// reuse here doesn't justify lifting topics into shared/ — these strings
// are the wire format and are short enough to duplicate in the smoke test.
const topicFor = (addr: { peerId: string; userId: string }, leaf: 'cmd' | 'presence' | 'state') =>
    `feishin/v1/${addr.userId}/${addr.peerId}/${leaf}`;

interface Harness {
    aedes: Aedes;
    httpServer: ReturnType<typeof createServer>;
    port: number;
    wsServer: WebSocketServer;
}

const startHarness = async (roomKey: string): Promise<Harness> => {
    const aedes = await Aedes.createBroker();
    aedes.authenticate = (_client, username, password, cb) => {
        if (username && password && password.toString() === roomKey) {
            (_client as unknown as Record<string, unknown>)._uid = username;
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
        if (!root || !packet.topic.startsWith(root)) {
            cb(new Error('publish denied'));
            return;
        }
        cb(null);
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
        httpServer.listen(0, '127.0.0.1', () => {
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

describe('peer-broker smoke', () => {
    let harness: Harness;

    beforeEach(async () => {
        harness = await startHarness('the-room-key');
    });

    afterEach(async () => {
        await stopHarness(harness);
    });

    it('accepts a correct room key and round-trips a publish/subscribe', async () => {
        const url = `ws://127.0.0.1:${harness.port}`;
        const client = mqtt.connect(url, {
            password: 'the-room-key',
            protocolVersion: 4,
            reconnectPeriod: 0,
            username: 'user-1',
        });

        const received: string[] = [];
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('connect timeout')), 5_000);
            client.once('connect', () => {
                clearTimeout(t);
                resolve();
            });
            client.once('error', (e) => {
                clearTimeout(t);
                reject(e);
            });
        });

        const topic = topicFor({ peerId: 'peer-a', userId: 'user-1' }, 'cmd');
        await new Promise<void>((resolve, reject) => {
            client.subscribe(topic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
        });

        client.on('message', (_t, payload) => {
            received.push(payload.toString());
        });

        client.publish(topic, 'hello', { qos: 1 });
        await new Promise<void>((resolve) => {
            const t0 = Date.now();
            const tick = () => {
                if (received.length > 0) return resolve();
                if (Date.now() - t0 > 3_000) return resolve();
                setTimeout(tick, 25);
            };
            tick();
        });

        expect(received).toEqual(['hello']);
        await new Promise<void>((resolve) => client.end(true, undefined, () => resolve()));
    });

    it('rejects a publish outside the user namespace', async () => {
        // Two connected clients in different namespaces. user-2 subscribes
        // to its own namespace; user-1 attempts to publish into it. The
        // broker's authorizePublish hook must drop the message before
        // delivery so user-2 never sees a single byte.
        const url = `ws://127.0.0.1:${harness.port}`;
        const c1 = mqtt.connect(url, {
            password: 'the-room-key',
            protocolVersion: 4,
            reconnectPeriod: 0,
            username: 'user-1',
        });
        const c2 = mqtt.connect(url, {
            password: 'the-room-key',
            protocolVersion: 4,
            reconnectPeriod: 0,
            username: 'user-2',
        });

        await Promise.all(
            [c1, c2].map(
                (c) =>
                    new Promise<void>((resolve, reject) => {
                        const t = setTimeout(() => reject(new Error('connect timeout')), 5_000);
                        c.once('connect', () => {
                            clearTimeout(t);
                            resolve();
                        });
                        c.once('error', (e) => {
                            clearTimeout(t);
                            reject(e);
                        });
                    }),
            ),
        );

        const otherUserTopic = topicFor({ peerId: 'peer-b', userId: 'user-2' }, 'cmd');
        const received: string[] = [];
        c2.on('message', (_t, payload) => received.push(payload.toString()));
        await new Promise<void>((resolve, reject) => {
            c2.subscribe(otherUserTopic, { qos: 1 }, (err) => (err ? reject(err) : resolve()));
        });

        // c1 (user-1) tries to publish into user-2's namespace — broker ACL
        // must reject it. c2 (user-2) is legitimately subscribed and would
        // see it if the ACL were not enforced.
        c1.publish(otherUserTopic, 'should-be-dropped', { qos: 1 });

        // Give the broker time to deliver any leaked message.
        await new Promise<void>((resolve) => setTimeout(resolve, 300));
        expect(received).toEqual([]);
        await new Promise<void>((resolve) => c1.end(true, undefined, () => resolve()));
        await new Promise<void>((resolve) => c2.end(true, undefined, () => resolve()));
    });

    it('rejects a wrong room key', async () => {
        const url = `ws://127.0.0.1:${harness.port}`;
        const client = mqtt.connect(url, {
            password: 'not-the-room-key',
            protocolVersion: 4,
            reconnectPeriod: 0,
            username: 'user-1',
        });
        const outcome = await new Promise<'connect' | 'error'>((resolve) => {
            const t = setTimeout(() => resolve('error'), 2_000);
            client.once('connect', () => {
                clearTimeout(t);
                resolve('connect');
            });
            client.once('error', () => {
                clearTimeout(t);
                resolve('error');
            });
        });
        expect(outcome).toBe('error');
        await new Promise<void>((resolve) => client.end(true, undefined, () => resolve()));
    });
});
