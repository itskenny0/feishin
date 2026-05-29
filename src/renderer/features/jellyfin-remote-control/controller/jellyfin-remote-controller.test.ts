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

/**
 * Audit E2 + E4: the inbound message dispatcher.
 *
 * E2 — the PlayNow fast-path (queue already matches) issued the resume seek
 *      synchronously in the same tick as mediaPlayByIndex, before the new
 *      track's media element mounted, so the requested StartPositionTicks was
 *      lost. The fix mirrors the fresh-queue path and defers the seek into
 *      requestAnimationFrame.
 * E4 — Playstate / GeneralCommand / Play frames dereferenced msg.Data without
 *      guarding undefined/null, throwing a swallowed TypeError on a malformed
 *      frame instead of ignoring it like any other unknown shape.
 */
describe('dispatchJellyfinMessage — E2 fast-path seek deferral + E4 Data guards', () => {
    const TICKS_PER_SECOND = 10_000_000;

    // Hoisted so the player.store mock factory can close over them.
    const storeState = vi.hoisted(() => ({
        mediaPlayByIndex: vi.fn(),
        queue: {
            // ids 'a','b','c' with stable uniqueIds; index maps 1:1.
            default: ['ua', 'ub', 'uc'],
            shuffled: [] as number[],
            songs: {
                ua: { id: 'a' },
                ub: { id: 'b' },
                uc: { id: 'c' },
            } as Record<string, { id: string }>,
        },
    }));

    beforeEach(() => {
        vi.resetModules();
        storeState.mediaPlayByIndex.mockClear();
        vi.doMock('/@/renderer/store/player.store', () => ({
            addToQueueByData: vi.fn(async () => {}),
            isShuffleEnabled: () => false,
            usePlayerStoreBase: {
                getState: () => ({
                    ...storeState,
                    player: { muted: false },
                }),
            },
        }));
        vi.doMock('/@/shared/components/toast/toast', () => ({
            toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        }));
    });

    afterEach(() => {
        vi.doUnmock('/@/renderer/store/player.store');
        vi.doUnmock('/@/shared/components/toast/toast');
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const importDispatcher = async () => {
        const mod =
            await import('/@/renderer/features/jellyfin-remote-control/controller/message-dispatcher');
        return mod.dispatchJellyfinMessage;
    };

    const mkDeps = () => {
        const mediaSeekToTimestamp = vi.fn();
        return {
            deps: {
                defaultVolumeStep: 5,
                fetchSongsByIds: vi.fn(async () => []),
                playerActions: {
                    decreaseVolume: vi.fn(),
                    increaseVolume: vi.fn(),
                    mediaNext: vi.fn(),
                    mediaPause: vi.fn(),
                    mediaPlay: vi.fn(),
                    mediaPrevious: vi.fn(),
                    mediaSeekToTimestamp,
                    mediaSkipBackward: vi.fn(),
                    mediaSkipForward: vi.fn(),
                    mediaStop: vi.fn(),
                    mediaToggleMute: vi.fn(),
                    mediaTogglePlayPause: vi.fn(),
                    setRepeat: vi.fn(),
                    setShuffle: vi.fn(),
                    setVolume: vi.fn(),
                },
            },
            mediaSeekToTimestamp,
        };
    };

    it('E2: PlayNow fast-path jumps synchronously but defers the resume seek to a rAF tick', async () => {
        // Mock rAF so we control exactly when the deferred seek runs.
        const rafCbs: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            rafCbs.push(cb);
            return rafCbs.length;
        });

        const dispatch = await importDispatcher();
        const { deps, mediaSeekToTimestamp } = mkDeps();

        // ItemIds match the current queue exactly; StartIndex points at a
        // different track; StartPositionTicks > 0 (resume mid-track).
        await dispatch(
            {
                Data: {
                    ItemIds: ['a', 'b', 'c'],
                    PlayCommand: 'PlayNow',
                    StartIndex: 2,
                    StartPositionTicks: 90 * TICKS_PER_SECOND,
                },
                MessageType: 'Play',
            } as never,
            deps as never,
        );

        // The track jump is synchronous (fast path).
        expect(storeState.mediaPlayByIndex).toHaveBeenCalledTimes(1);
        expect(storeState.mediaPlayByIndex).toHaveBeenCalledWith(2);

        // The seek MUST be deferred — nothing yet.
        expect(mediaSeekToTimestamp).not.toHaveBeenCalled();
        expect(rafCbs.length).toBe(1);

        // Run the rAF callback; only now does the seek land, in SECONDS.
        rafCbs.forEach((cb) => cb(0));
        expect(mediaSeekToTimestamp).toHaveBeenCalledTimes(1);
        expect(mediaSeekToTimestamp).toHaveBeenCalledWith(90);

        vi.unstubAllGlobals();
    });

    it('E2: fresh-queue path also defers its seek to a rAF tick (symmetry)', async () => {
        // Re-mock player.store so the queue does NOT match -> fresh-queue path.
        vi.doMock('/@/renderer/store/player.store', () => ({
            addToQueueByData: vi.fn(async () => {}),
            isShuffleEnabled: () => false,
            usePlayerStoreBase: {
                getState: () => ({
                    mediaPlayByIndex: storeState.mediaPlayByIndex,
                    player: { muted: false },
                    // Empty default => fresh-queue (and wasIdle), but we seed
                    // fetched songs below so StartIndex>0 path runs.
                    queue: { default: [], shuffled: [], songs: {} },
                }),
            },
        }));

        const dispatch = await importDispatcher();
        const { deps, mediaSeekToTimestamp } = mkDeps();
        // Return 3 songs so startIndex=2 is in range.
        (deps.fetchSongsByIds as ReturnType<typeof vi.fn>).mockResolvedValue([
            { id: 'a' },
            { id: 'b' },
            { id: 'c' },
        ]);

        const rafCbs: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
            rafCbs.push(cb);
            return rafCbs.length;
        });

        await dispatch(
            {
                Data: {
                    ItemIds: ['a', 'b', 'c'],
                    PlayCommand: 'PlayNow',
                    StartIndex: 2,
                    StartPositionTicks: 30 * TICKS_PER_SECOND,
                },
                MessageType: 'Play',
            } as never,
            deps as never,
        );

        expect(mediaSeekToTimestamp).not.toHaveBeenCalled();
        expect(rafCbs.length).toBe(1);
        rafCbs.forEach((cb) => cb(0));
        expect(mediaSeekToTimestamp).toHaveBeenCalledWith(30);

        vi.unstubAllGlobals();
    });

    it('E4: a Playstate frame with no Data is ignored without throwing or dispatching', async () => {
        const dispatch = await importDispatcher();
        const { deps } = mkDeps();
        await expect(
            dispatch({ MessageType: 'Playstate' } as never, deps as never),
        ).resolves.toBeUndefined();
        await expect(
            dispatch({ Data: null, MessageType: 'Playstate' } as never, deps as never),
        ).resolves.toBeUndefined();
        expect(deps.playerActions.mediaNext).not.toHaveBeenCalled();
        expect(deps.playerActions.mediaPause).not.toHaveBeenCalled();
    });

    it('E4: a GeneralCommand frame with no Data is ignored without throwing or dispatching', async () => {
        const dispatch = await importDispatcher();
        const { deps } = mkDeps();
        await expect(
            dispatch({ MessageType: 'GeneralCommand' } as never, deps as never),
        ).resolves.toBeUndefined();
        await expect(
            dispatch({ Data: null, MessageType: 'GeneralCommand' } as never, deps as never),
        ).resolves.toBeUndefined();
        expect(deps.playerActions.setVolume).not.toHaveBeenCalled();
        expect(deps.playerActions.mediaToggleMute).not.toHaveBeenCalled();
    });

    it('E4: a Play frame with no Data is ignored without throwing', async () => {
        const dispatch = await importDispatcher();
        const { deps } = mkDeps();
        await expect(
            dispatch({ MessageType: 'Play' } as never, deps as never),
        ).resolves.toBeUndefined();
        expect(deps.fetchSongsByIds).not.toHaveBeenCalled();
        expect(storeState.mediaPlayByIndex).not.toHaveBeenCalled();
    });

    it('E4: a valid Playstate still dispatches (guard is not over-broad)', async () => {
        const dispatch = await importDispatcher();
        const { deps } = mkDeps();
        await dispatch(
            { Data: { Command: 'NextTrack' }, MessageType: 'Playstate' } as never,
            deps as never,
        );
        expect(deps.playerActions.mediaNext).toHaveBeenCalledTimes(1);
    });

    it('E4: a valid GeneralCommand still dispatches (guard is not over-broad)', async () => {
        const dispatch = await importDispatcher();
        const { deps } = mkDeps();
        await dispatch(
            {
                Data: { Arguments: { Volume: '40' }, Name: 'SetVolume' },
                MessageType: 'GeneralCommand',
            } as never,
            deps as never,
        );
        expect(deps.playerActions.setVolume).toHaveBeenCalledWith(40);
    });
});
