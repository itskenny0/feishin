import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { JellyfinRemoteController } from '/@/renderer/features/jellyfin-remote-control/controller/jellyfin-remote-controller';

/**
 * Minimal WebSocket double — captures sent frames and exposes simulate*
 * hooks for the test. Matches just enough of the real WebSocket surface
 * for the controller to drive it through openSocket().
 */
class FakeSocket {
    static instances: FakeSocket[] = [];
    static OPEN = 1;

    onclose: ((e: { code: number; wasClean: boolean }) => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;

    onopen: (() => void) | null = null;
    readyState = 1;
    sent: string[] = [];
    url: string;

    constructor(url: string) {
        this.url = url;
        FakeSocket.instances.push(this);
    }

    close() {
        this.readyState = 3;
    }

    receive(payload: object) {
        this.onmessage?.({ data: JSON.stringify(payload) });
    }

    send(data: string) {
        this.sent.push(data);
    }
}

const startCtl = async (overrides?: Partial<Parameters<JellyfinRemoteController['start']>[0]>) => {
    const ctl = new JellyfinRemoteController();
    // Stub capabilities POST so we don't hit the network.
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 204 })),
    );
    await ctl.start({
        authHeader: 'MediaBrowser X="Y"',
        capabilitiesPayload: {},
        client: 'Feishin',
        device: 'TestRig',
        deviceId: 'dev-1',
        dispatcherDeps: {
            defaultVolumeStep: 5,
            fetchSongsByIds: async () => [],
            playerActions: {} as never,
        },
        serverUrl: 'https://example.test',
        token: 'tok',
        version: '1.12.0',
        ...overrides,
    });
    return ctl;
};

describe('JellyfinRemoteController — keepalive contract', () => {
    beforeEach(() => {
        FakeSocket.instances = [];
        vi.useFakeTimers();
        vi.stubGlobal('WebSocket', FakeSocket);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        FakeSocket.instances = [];
    });

    it('ACKs ForceKeepAlive immediately so the server keeps pushing (regression: commands-stack-up-then-burst)', async () => {
        const ctl = await startCtl();
        const sock = FakeSocket.instances[0];
        expect(sock).toBeDefined();

        sock.onopen?.();
        sock.sent = [];

        // Server demands KeepAlive at 60s cadence.
        sock.receive({ Data: 60, MessageType: 'ForceKeepAlive' });

        // We must reply with a KeepAlive within the same tick.
        const acked = sock.sent.some((m) => JSON.parse(m).MessageType === 'KeepAlive');
        expect(acked).toBe(true);

        ctl.stop();
    });

    it('sends SessionsStart on socket open when subscribeToSessions is set', async () => {
        const ctl = await startCtl({ subscribeToSessions: true });
        const sock = FakeSocket.instances[0];
        sock.onopen?.();

        const startMsg = sock.sent
            .map((m) => JSON.parse(m))
            .find((m) => m.MessageType === 'SessionsStart');
        expect(startMsg).toBeDefined();
        // "<initialDelayMs>,<periodMs>" CSV — periodMs > 0 so the server
        // pushes deltas instead of only fast-forwarding the initial snapshot.
        expect(typeof startMsg.Data).toBe('string');
        expect(startMsg.Data.split(',').length).toBe(2);
        ctl.stop();
    });

    it('routes Sessions snapshots through the supplied callback', async () => {
        const onSessionsPayload = vi.fn();
        const ctl = await startCtl({ onSessionsPayload, subscribeToSessions: true });
        const sock = FakeSocket.instances[0];
        sock.onopen?.();

        const sessionPayload = [{ DeviceId: 'd', Id: 's' }];
        sock.receive({ Data: sessionPayload, MessageType: 'Sessions' });

        expect(onSessionsPayload).toHaveBeenCalledOnce();
        expect(onSessionsPayload).toHaveBeenCalledWith(sessionPayload);
        ctl.stop();
    });

    it('ignores server-originated KeepAlive (no double-ACK loop)', async () => {
        const ctl = await startCtl();
        const sock = FakeSocket.instances[0];
        sock.onopen?.();
        sock.sent = [];

        sock.receive({ MessageType: 'KeepAlive' });

        expect(sock.sent).toEqual([]);
        ctl.stop();
    });

    /**
     * Regression: `lastSocketOpenedAt` was initialised to 0, so a sequence
     * of sockets that closed BEFORE ever opening (the case for an
     * unreachable / DNS-failed server) saw `Date.now() - 0` always exceed
     * the success-uptime threshold and reset the retry counter on every
     * close. The backoff then never escalated — the controller would hammer
     * an unreachable server at the 1s base delay forever.
     *
     * Expected behavior: backoff escalates 1s → 2s → 5s → 10s → 30s when no
     * socket has ever opened. We assert the 2nd reconnect is delayed by 2s
     * (rung 1), proving the counter advanced rather than resetting to 0.
     */
    it('does NOT reset the retry counter when sockets never open (unreachable server)', async () => {
        const ctl = await startCtl();
        // First socket: close it immediately, *without* calling onopen.
        const sock0 = FakeSocket.instances[0];
        expect(sock0).toBeDefined();
        sock0.onclose?.({ code: 1006, wasClean: false });
        // First reconnect rung: 1s.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(FakeSocket.instances.length).toBe(2);
        const sock1 = FakeSocket.instances[1];
        sock1.onclose?.({ code: 1006, wasClean: false });
        // If counter was wrongly reset to 0 here, the 3rd socket would
        // schedule at 1s (rung 0). With correct behavior it schedules at
        // 2s (rung 1).
        await vi.advanceTimersByTimeAsync(1_500);
        expect(FakeSocket.instances.length).toBe(2);
        await vi.advanceTimersByTimeAsync(700);
        expect(FakeSocket.instances.length).toBe(3);
        ctl.stop();
    });
});
