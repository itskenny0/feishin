/**
 * Embedded MQTT broker for peer-sync.
 *
 * `aedes` over WebSocket so the renderer (which can only do WS in the web
 * build) and the main-process desktop side speak the same protocol. The
 * broker is **opt-in**: the renderer flips `enabled` via IPC when the user
 * toggles the corresponding settings switch. Disabled is the default and
 * Feishin behaves identically to upstream when the setting is off.
 *
 * mDNS announcement uses `bonjour-service` so other Feishins on the same
 * LAN can auto-discover the broker without configuring an URL.
 *
 * Security model:
 *
 *   - The MQTT username is the Jellyfin user id; password is the shared
 *     room key. Both must match the room key the broker was started with.
 *   - Each connected client is sandboxed to its userId namespace via
 *     authorizePublish / authorizeSubscribe. A misbehaving client cannot
 *     read or write outside its own `feishin/v1/<userId>/+/+` subtree.
 *   - TLS is optional and self-signed: the cert path comes in via IPC and
 *     is read from disk at start; the renderer is responsible for
 *     generating one on first opt-in.
 */
import { Aedes } from 'aedes';
import type { AuthErrorCode } from 'aedes';
import Bonjour from 'bonjour-service';

// MQTT CONNACK return code for "Bad username or password". Mirrors aedes'
// `AuthErrorCode.BAD_USERNAME_OR_PASSWORD` const enum, which can't be
// referenced under `isolatedModules`.
const CONNACK_BAD_CREDENTIALS = 4 as AuthErrorCode;
import { ipcMain } from 'electron';
import { readFile } from 'fs/promises';
import { createServer as createHttpServer, Server as HttpServer } from 'http';
import { createServer as createHttpsServer, Server as HttpsServer } from 'https';
import { WebSocketServer } from 'ws';
import { createWebSocketStream } from 'ws';

const TAG = '[peer-broker]';
const log = (...args: unknown[]) => console.info(TAG, ...args);
const warn = (...args: unknown[]) => console.warn(TAG, ...args);

const MDNS_SERVICE_TYPE = 'feishin-mqtt';

export interface PeerBrokerConfig {
    /** Listen host. `0.0.0.0` exposes the broker on the LAN. */
    host: string;
    /** Listen port. Must be free on the host. */
    port: number;
    /** Shared room key — clients must present this as the MQTT password. */
    roomKey: string;
    /** Optional TLS cert path; pair `tlsCertPath`+`tlsKeyPath` to enable. */
    tlsCertPath?: string;
    /** Optional TLS key path. */
    tlsKeyPath?: string;
}

interface ActiveBroker {
    aedes: Aedes;
    bonjour: InstanceType<typeof Bonjour>;
    config: PeerBrokerConfig;
    httpServer: HttpServer | HttpsServer;
    service: ReturnType<InstanceType<typeof Bonjour>['publish']>;
    wsServer: WebSocketServer;
}

let active: ActiveBroker | null = null;

/**
 * Topic-prefix gate for a client. The MQTT username (Jellyfin user id) is
 * baked into the namespace; a client connecting as user A cannot publish or
 * subscribe under user B's prefix.
 */
const allowedRoot = (username: string | undefined): string | null => {
    if (!username) return null;
    return `feishin/v1/${username}/`;
};

const isUnderRoot = (topic: string, root: string): boolean =>
    topic.startsWith(root) || topic === root.slice(0, -1);

const attachHandlers = (aedes: Aedes, roomKey: string): void => {
    aedes.authenticate = (client, username, password, callback) => {
        const usernameOk = typeof username === 'string' && username.length > 0;
        const presented = password ? password.toString() : '';
        const passwordOk = presented === roomKey;
        if (!usernameOk || !passwordOk) {
            warn('authenticate denied', { clientId: client.id });
            const err = new Error('Bad credentials') as Error & { returnCode: AuthErrorCode };
            err.returnCode = CONNACK_BAD_CREDENTIALS;
            callback(err, false);
            return;
        }
        // Stash the userId on the client for the ACL hooks below.
        (client as unknown as Record<string, unknown>)._feishinUserId = username;
        log('client authenticated', { clientId: client.id, username });
        callback(null, true);
    };

    aedes.authorizePublish = (client, packet, callback) => {
        const username = client
            ? ((client as unknown as Record<string, unknown>)._feishinUserId as string | undefined)
            : undefined;
        const root = allowedRoot(username);
        if (!root || !isUnderRoot(packet.topic, root)) {
            warn('publish denied', { clientId: client?.id, topic: packet.topic });
            callback(new Error('publish out of namespace'));
            return;
        }
        callback(null);
    };

    aedes.authorizeSubscribe = (client, sub, callback) => {
        const username = client
            ? ((client as unknown as Record<string, unknown>)._feishinUserId as string | undefined)
            : undefined;
        const root = allowedRoot(username);
        if (!root) {
            callback(new Error('subscribe out of namespace'), null);
            return;
        }
        // Wildcards: only accept patterns under our root. We allow exactly
        // the shape `feishin/v1/<user>/...` — the client's room is its own
        // userId subtree.
        if (!sub.topic.startsWith(root)) {
            warn('subscribe denied', { clientId: client?.id, topic: sub.topic });
            callback(new Error('subscribe out of namespace'), null);
            return;
        }
        callback(null, sub);
    };

    aedes.on('client', (client) => {
        log('client connected', { clientId: client.id });
    });
    aedes.on('clientDisconnect', (client) => {
        log('client disconnected', { clientId: client.id });
    });
    aedes.on('subscribe', (subs, client) => {
        log('subscribed', {
            clientId: client?.id,
            topics: subs.map((s) => s.topic),
        });
    });
};

const buildHttpServer = async (config: PeerBrokerConfig): Promise<HttpServer | HttpsServer> => {
    if (config.tlsCertPath && config.tlsKeyPath) {
        const [cert, key] = await Promise.all([
            readFile(config.tlsCertPath),
            readFile(config.tlsKeyPath),
        ]);
        return createHttpsServer({ cert, key });
    }
    return createHttpServer();
};

/**
 * Boot the embedded broker. Idempotent — if a broker is already running on
 * the same port the call is a no-op.
 */
export const startPeerBroker = async (config: PeerBrokerConfig): Promise<void> => {
    if (active) {
        const same =
            active.config.host === config.host &&
            active.config.port === config.port &&
            active.config.roomKey === config.roomKey;
        if (same) return;
        await stopPeerBroker();
    }

    log('starting', { host: config.host, port: config.port, tls: Boolean(config.tlsCertPath) });

    const aedes = await Aedes.createBroker();
    attachHandlers(aedes, config.roomKey);

    const httpServer = await buildHttpServer(config);
    const wsServer = new WebSocketServer({ server: httpServer });

    wsServer.on('connection', (ws, req) => {
        const stream = createWebSocketStream(ws);
        aedes.handle(stream as unknown as Parameters<typeof aedes.handle>[0], req as never);
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
            httpServer.removeListener('listening', onListening);
            reject(err);
        };
        const onListening = () => {
            httpServer.removeListener('error', onError);
            resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        httpServer.listen(config.port, config.host);
    });

    const bonjour = new Bonjour();
    const service = bonjour.publish({
        name: 'Feishin Peer Sync',
        port: config.port,
        protocol: 'tcp',
        txt: {
            tls: config.tlsCertPath ? '1' : '0',
            v: '1',
        },
        type: MDNS_SERVICE_TYPE,
    });

    active = { aedes, bonjour, config, httpServer, service, wsServer };
    log('started', { host: config.host, port: config.port });
};

/** Tear the broker down. Closes the WS, the HTTP server, and the mDNS service. */
export const stopPeerBroker = async (): Promise<void> => {
    if (!active) return;
    log('stopping');
    const { aedes, bonjour, httpServer, service, wsServer } = active;
    active = null;

    try {
        service.stop?.();
        bonjour.unpublishAll();
        bonjour.destroy();
    } catch (err) {
        warn('mdns shutdown failed', { err: (err as Error).message });
    }

    await new Promise<void>((resolve) => {
        wsServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
        aedes.close(() => resolve());
    });
    log('stopped');
};

export const isPeerBrokerRunning = (): boolean => active !== null;

// IPC contract used by the renderer Settings UI. Returns null on success
// or an error message string on failure — mirrors the existing `remote-*`
// IPC channels for symmetry.
ipcMain.handle('peer-broker-enable', async (_event, config: PeerBrokerConfig | null) => {
    try {
        if (config) {
            await startPeerBroker(config);
        } else {
            await stopPeerBroker();
        }
        return null;
    } catch (err) {
        warn('enable failed', { err: (err as Error).message });
        return (err as Error).message;
    }
});

ipcMain.handle('peer-broker-status', () => isPeerBrokerRunning());
