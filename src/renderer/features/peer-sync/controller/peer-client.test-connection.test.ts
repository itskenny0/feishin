/**
 * `testBrokerConnection` — the wizard's broker-reachability probe.
 *
 * Mirrors the live connect path (resolveEffectiveTransport → WS via
 * mqtt.connect for the ws/bare cases here) but is one-shot: resolves on the
 * first CONNACK / error / timeout, never throws, and always tears the client
 * down (end(true)) + clears its timer. We drive a fake mqtt client so we can
 * fire connect/error explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

class FakeMqttClient {
    connected = false;

    ended = false;

    listenersCleared = false;

    private handlers = new Map<string, Handler[]>();

    emit(event: string, ...args: unknown[]): void {
        for (const h of this.handlers.get(event) ?? []) h(...args);
    }

    end(_force?: boolean, _opts?: unknown, cb?: () => void): void {
        this.ended = true;
        this.connected = false;
        cb?.();
    }

    on(event: string, handler: Handler): this {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }

    removeAllListeners(): this {
        this.listenersCleared = true;
        this.handlers.clear();
        return this;
    }
}

const fakeClients: FakeMqttClient[] = [];
const connectSpy = vi.fn((_url?: string, _opts?: Record<string, unknown>) => {
    const c = new FakeMqttClient();
    fakeClients.push(c);
    return c;
});

vi.mock('mqtt', () => ({
    default: {
        connect: (url?: string, opts?: Record<string, unknown>) => connectSpy(url, opts),
    },
}));

const importApi = () => import('/@/renderer/features/peer-sync/controller/peer-client');

beforeEach(() => {
    fakeClients.length = 0;
    connectSpy.mockClear();
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('testBrokerConnection', () => {
    it('resolves ok:false immediately for an empty URL without touching mqtt', async () => {
        const { testBrokerConnection } = await importApi();
        const result = await testBrokerConnection('   ');
        expect(result.ok).toBe(false);
        expect(connectSpy).not.toHaveBeenCalled();
    });

    it('resolves ok:true on the first CONNACK and tears the probe down', async () => {
        const { testBrokerConnection } = await importApi();
        const promise = testBrokerConnection('ws://broker.lan:8083');
        const client = fakeClients[0];
        expect(client).toBeDefined();
        client.emit('connect');
        const result = await promise;
        expect(result.ok).toBe(true);
        expect(client.ended).toBe(true);
        expect(client.listenersCleared).toBe(true);
    });

    it('resolves ok:false with the error message on an mqtt error', async () => {
        const { testBrokerConnection } = await importApi();
        const promise = testBrokerConnection('ws://broker.lan:8083');
        const client = fakeClients[0];
        client.emit('error', new Error('Connection refused'));
        const result = await promise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('Connection refused');
        expect(client.ended).toBe(true);
    });

    it('times out (ok:false) when no CONNACK ever arrives, and clears the timer', async () => {
        const { testBrokerConnection } = await importApi();
        const promise = testBrokerConnection('ws://silent.lan:8083', { timeoutMs: 8_000 });
        const client = fakeClients[0];
        // No connect/error event — advance past the timeout.
        await vi.advanceTimersByTimeAsync(8_000);
        const result = await promise;
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/timed out/i);
        expect(client.ended).toBe(true);
    });

    it('passes external credentials through when a username is supplied', async () => {
        const { testBrokerConnection } = await importApi();
        const promise = testBrokerConnection('ws://broker.lan:8083', {
            password: 'sekret',
            username: 'bob',
        });
        fakeClients[0].emit('connect');
        await promise;
        const opts = connectSpy.mock.calls[0][1] ?? {};
        expect(opts.username).toBe('bob');
        expect(opts.password).toBe('sekret');
    });

    // S2-B: with no external username, the probe must send the embedded-scheme
    // userId/roomKey EXACTLY like the live client, so the gate predicts a live
    // connect against an auth-enforcing embedded broker (no more anonymous
    // false-FAIL / false-PASS).
    it('falls back to the embedded userId/roomKey when no external username (S2-B)', async () => {
        const { testBrokerConnection } = await importApi();
        const promise = testBrokerConnection('ws://broker.lan:8083', {
            roomKey: 'carol',
            userId: 'user-guid',
        });
        fakeClients[0].emit('connect');
        await promise;
        const opts = connectSpy.mock.calls[0][1] ?? {};
        expect(opts.username).toBe('user-guid');
        expect(opts.password).toBe('carol');
    });

    it('external username still wins over the embedded scheme (S2-B)', async () => {
        const { testBrokerConnection } = await importApi();
        const promise = testBrokerConnection('ws://broker.lan:8083', {
            password: 'sekret',
            roomKey: 'carol',
            userId: 'user-guid',
            username: 'bob',
        });
        fakeClients[0].emit('connect');
        await promise;
        const opts = connectSpy.mock.calls[0][1] ?? {};
        expect(opts.username).toBe('bob');
        expect(opts.password).toBe('sekret');
    });

    it('does not throw when mqtt.connect throws synchronously', async () => {
        connectSpy.mockImplementationOnce(() => {
            throw new Error('bad url');
        });
        const { testBrokerConnection } = await importApi();
        const result = await testBrokerConnection('ws://broker.lan:8083');
        expect(result.ok).toBe(false);
        expect(result.error).toBe('bad url');
    });
});
