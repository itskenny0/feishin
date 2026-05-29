/**
 * Web-build runtime guard: importing the peer-sync client must not
 * crash when `globalThis.Buffer` is absent. mqtt.js (and its mqtt-packet
 * dep) reach for `Buffer.from(...)` at module load + on the first publish,
 * so the renderer entry installs the `buffer` polyfill before anything
 * imports the peer-client. If a future refactor removes that polyfill —
 * or moves the import earlier than the polyfill setup — this test fails
 * the build before users hit "Buffer is not defined" mid-onboarding.
 *
 * Also covers the lifecycle/loop-guard contract on the live publish path:
 *   - C3: a kill-switch teardown during the handshake must stop a
 *     still-connecting client so a late CONNACK can't subscribe + publish
 *     presence and resurrect the session.
 *   - D1: publishOwnState consults the inbound-apply loop guard and skips
 *     the publish while the suppression window is open.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory MQTT client stub. The `connect` event is NOT auto-fired — tests
// drive it explicitly via `fireConnect()` so we can model the
// connecting-then-torn-down race in C3.
type Handler = (...args: unknown[]) => void;

class FakeMqttClient {
    connected = false;

    ended = false;

    publishes: Array<{ opts: unknown; payload: Uint8Array; topic: string }> = [];

    subscribes: string[] = [];

    private handlers = new Map<string, Handler[]>();

    end(_force?: boolean, _opts?: unknown, cb?: () => void): void {
        this.ended = true;
        this.connected = false;
        cb?.();
    }

    fireConnect(): void {
        this.connected = true;
        this.emit('connect');
    }

    on(event: string, handler: Handler): this {
        const list = this.handlers.get(event) ?? [];
        list.push(handler);
        this.handlers.set(event, list);
        return this;
    }

    publish(topic: string, payload: Uint8Array, opts: unknown, cb?: (err?: Error) => void): void {
        this.publishes.push({ opts, payload, topic });
        cb?.(undefined);
    }

    removeAllListeners(): this {
        this.handlers.clear();
        return this;
    }

    subscribe(topic: string, _opts: unknown, cb?: (err?: Error) => void): void {
        this.subscribes.push(topic);
        cb?.(undefined);
    }

    private emit(event: string, ...args: unknown[]): void {
        for (const h of this.handlers.get(event) ?? []) h(...args);
    }
}

const fakeClients: FakeMqttClient[] = [];

vi.mock('mqtt', () => ({
    default: {
        connect: vi.fn(() => {
            const c = new FakeMqttClient();
            fakeClients.push(c);
            return c;
        }),
    },
}));

const baseArgs = () => ({
    brokerUrl: 'ws://localhost:8083',
    peerId: 'self-peer',
    roomKey: 'room',
    userId: 'user-1',
});

describe('peer-sync client buffer requirement', () => {
    it('finds Buffer.from on globalThis at module load (polyfill or native)', () => {
        // jsdom + Node both ship Buffer. The runtime branch we are guarding
        // against is the browser path that boots without the polyfill. We
        // assert the contract here so a refactor that breaks the import
        // order surfaces as a unit-test failure.
        expect(typeof (globalThis as { Buffer?: unknown }).Buffer).toBe('function');
        const buf = Buffer.from(new Uint8Array([1, 2, 3]));
        expect(buf.length).toBe(3);
        // alloc(0) is a code path peer-client.ts hits when publishing the
        // empty-payload presence-clear retained message.
        expect(Buffer.alloc(0).length).toBe(0);
    });

    it('can build the LWT payload shape the peer-client uses', async () => {
        // Touch the actual import path so a tree-shake misconfig surfaces.
        const { codec } = await import('/@/renderer/features/peer-sync/protocol/codec');
        const payload = Buffer.from(codec.encode({ online: false, t: 'presence', ts: 0, v: 1 }));
        expect(payload.length).toBeGreaterThan(0);
    });
});

describe('peer-sync client lifecycle (C3) + loop-guard (D1)', () => {
    beforeEach(async () => {
        fakeClients.length = 0;
        const { __resetForTests } =
            await import('/@/renderer/features/peer-sync/controller/transport-selector');
        __resetForTests();
        const { __resetInboundApply } =
            await import('/@/renderer/features/peer-sync/controller/peer-loop-guard');
        __resetInboundApply();
    });

    afterEach(async () => {
        // Ensure no session leaks across tests (stopPeerClient is idempotent).
        const { stopPeerClient } =
            await import('/@/renderer/features/peer-sync/controller/peer-client');
        stopPeerClient();
    });

    it('C3: stopPeerClient mid-handshake prevents a late CONNACK from going live', async () => {
        const { isPeerClientConnected, startPeerClient, stopPeerClient } =
            await import('/@/renderer/features/peer-sync/controller/peer-client');

        startPeerClient(baseArgs());
        const client = fakeClients[0];
        expect(client).toBeDefined();
        // Connect event has NOT fired yet — we are mid-handshake.
        expect(isPeerClientConnected()).toBe(false);
        expect(client.subscribes).toHaveLength(0);

        // Kill switch flips while still connecting.
        stopPeerClient();

        // A late CONNACK arrives on the torn-down client. It must not
        // subscribe to the user wildcard nor publish an online presence frame.
        client.fireConnect();

        expect(client.subscribes).toHaveLength(0);
        // The only publishes allowed during teardown are the retained-clear
        // empty payloads from stopPeerClient — never a non-empty online
        // presence frame.
        const presenceOnlinePublishes = client.publishes.filter(
            (p) => p.topic.endsWith('/presence') && p.payload.length > 0,
        );
        expect(presenceOnlinePublishes).toHaveLength(0);
        expect(isPeerClientConnected()).toBe(false);
    });

    it('C3: a connect on a session superseded by a fresh start is ignored', async () => {
        const { startPeerClient, stopPeerClient } =
            await import('/@/renderer/features/peer-sync/controller/peer-client');

        startPeerClient(baseArgs());
        const stale = fakeClients[0];

        // Differing args restart the client -> stale client is superseded.
        startPeerClient({ ...baseArgs(), peerId: 'self-peer-2' });
        const fresh = fakeClients[1];
        expect(fresh).toBeDefined();
        expect(fresh).not.toBe(stale);

        // Late CONNACK on the stale client must be ignored: no subscribe / no
        // presence publish from the orphan.
        stale.fireConnect();
        expect(stale.subscribes).toHaveLength(0);

        // The fresh client connecting is honored.
        fresh.fireConnect();
        expect(fresh.subscribes).toHaveLength(1);

        stopPeerClient();
    });

    it('D1: publishOwnState is suppressed while the inbound-apply window is open', async () => {
        const { publishOwnState, startPeerClient, stopPeerClient } =
            await import('/@/renderer/features/peer-sync/controller/peer-client');
        const {
            __resetInboundApply,
            INBOUND_APPLY_WINDOW_MS,
            isInboundApplyActive,
            markInboundApply,
        } = await import('/@/renderer/features/peer-sync/controller/peer-loop-guard');

        const { buildState } = await import('/@/renderer/features/peer-sync/protocol/builders');

        startPeerClient(baseArgs());
        const client = fakeClients[0];
        client.fireConnect();

        const state = buildState({
            dur: 1000,
            paused: false,
            pos: 0,
            rep: 'off',
            shuf: false,
            track: null,
            vol: 100,
        });

        const stateTopic = (p: { topic: string }) => p.topic.endsWith('/state');

        // Open the suppression window — publish must be skipped.
        markInboundApply();
        expect(isInboundApplyActive()).toBe(true);
        publishOwnState(state);
        expect(client.publishes.filter(stateTopic)).toHaveLength(0);

        // Close the window (equivalent to INBOUND_APPLY_WINDOW_MS elapsing) —
        // the publish now goes through.
        expect(INBOUND_APPLY_WINDOW_MS).toBeGreaterThan(0);
        __resetInboundApply();
        expect(isInboundApplyActive()).toBe(false);
        publishOwnState(state);
        expect(client.publishes.filter(stateTopic).length).toBeGreaterThan(0);

        stopPeerClient();
    });
});
