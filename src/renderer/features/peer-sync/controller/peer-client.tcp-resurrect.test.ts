/**
 * S2-C: native-TCP async resurrection-after-teardown guard.
 *
 * The TCP path builds its mqtt.js streamBuilder behind a dynamic import (real
 * latency on first connect). If `stopPeerClient()` runs DURING that await
 * (kill switch / unmount), the `.then` callback used to proceed because its
 * guard was `if (session && session.args !== args)` — a null `session` made the
 * guard falsy and it fell through to construct a client and assign `session`,
 * resurrecting a just-torn-down subsystem on TCP.
 *
 * The fix drops the leading `session &&` (now `session?.args !== args`) so a
 * null session bails. This test drives the TCP path with a DEFERRED builder,
 * tears down mid-await, then resolves the builder and asserts no client is
 * constructed / no session is created.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('is-electron', () => ({ default: () => true }));

// Track MqttClient constructions on the TCP path. mqtt.connect (WS path) is
// also stubbed so a fallback doesn't blow up.
const tcpClientConstructions: unknown[] = [];
class FakeTcpMqttClient {
    connected = false;

    constructor(_sb: unknown, _opts: unknown) {
        tcpClientConstructions.push(this);
    }

    end(_force?: boolean, _opts?: unknown, cb?: () => void): void {
        cb?.();
    }

    on(): this {
        return this;
    }

    publish(_t: string, _p: unknown, _o: unknown, cb?: (e?: Error) => void): void {
        cb?.(undefined);
    }

    removeAllListeners(): this {
        return this;
    }

    subscribe(_t: string, _o: unknown, cb?: (e?: Error) => void): void {
        cb?.(undefined);
    }
}

const wsConnects: unknown[] = [];
vi.mock('mqtt', () => ({
    default: {
        connect: vi.fn(() => {
            const c = new FakeTcpMqttClient(null, null);
            wsConnects.push(c);
            return c;
        }),
        MqttClient: FakeTcpMqttClient,
    },
}));

// Deferred stream builder: the controller awaits createElectronTcpSocketPlugin
// (via resolveTcpPlugin's dynamic import) then createNativeTcpStreamBuilder. We
// gate the FIRST dynamic import on a promise we resolve manually so we can tear
// down precisely while the await is pending.
let releaseBuilder: () => void = () => {};
const builderGate = new Promise<void>((res) => {
    releaseBuilder = res;
});
vi.mock('/@/renderer/features/peer-sync/transport/native-tcp-stream', () => ({
    createElectronTcpSocketPlugin: vi.fn(async () => {
        await builderGate; // block until the test releases us
        return {} as never;
    }),
    createNativeTcpStreamBuilder: vi.fn(() => () => ({}) as never),
}));

const tcpArgs = () => ({
    brokerUrl: 'mqtt://broker.lan:1883',
    peerId: 'self-peer',
    roomKey: 'room',
    tls: false,
    transport: 'tcp' as const,
    userId: 'user-1',
});

beforeEach(() => {
    tcpClientConstructions.length = 0;
    wsConnects.length = 0;
    // Expose the Electron TCP bridge so resolveTcpPlugin picks the Electron
    // path (getElectronTcpBridge reads globalThis.api.tcpSocket).
    (globalThis as { api?: { tcpSocket?: unknown } }).api = { tcpSocket: {} };
});

afterEach(async () => {
    delete (globalThis as { api?: unknown }).api;
    const { stopPeerClient } =
        await import('/@/renderer/features/peer-sync/controller/peer-client');
    stopPeerClient();
});

describe('peer-client native-TCP resurrection guard (S2-C)', () => {
    it('a teardown during the async builder import does NOT resurrect a session', async () => {
        const { isPeerClientConnected, startPeerClient, stopPeerClient } =
            await import('/@/renderer/features/peer-sync/controller/peer-client');

        // Start on the TCP path — the builder is now awaiting builderGate.
        startPeerClient(tcpArgs());

        // Kill switch fires while the dynamic import is still pending: session
        // is torn down to null.
        stopPeerClient();
        expect(isPeerClientConnected()).toBe(false);

        // Now release the builder. The .then callback runs with session===null
        // and MUST bail — no client construct, no WS fallback connect.
        releaseBuilder();
        // Let the microtask chain (createElectronTcpSocketPlugin →
        // createNativeTcpStreamBuilder → guard) settle.
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((res) => setTimeout(res, 0));

        expect(tcpClientConstructions).toHaveLength(0);
        expect(wsConnects).toHaveLength(0);
        expect(isPeerClientConnected()).toBe(false);
    });

    // The inverse regression (Windows, 2026-06-11): the S2-C guard compared
    // `session?.args !== args`, but on a FIRST connect `session` is still
    // null when the builder resolves (wire() hasn't run), so every initial
    // mqtt:// connect was dropped as "torn down" and the client went silent.
    // With no stop in between, the builder resolving MUST construct a client.
    it('a first connect with no teardown DOES construct the TCP client', async () => {
        const { startPeerClient } =
            await import('/@/renderer/features/peer-sync/controller/peer-client');

        startPeerClient(tcpArgs());
        // builderGate was released by the previous test, so the import chain
        // resolves on its own — just let the microtasks settle.
        await Promise.resolve();
        await Promise.resolve();
        await new Promise<void>((res) => setTimeout(res, 0));

        expect(tcpClientConstructions).toHaveLength(1);
        expect(wsConnects).toHaveLength(0);
    });
});
