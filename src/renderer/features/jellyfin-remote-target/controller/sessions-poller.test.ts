/**
 * Adaptive-cadence regression: a `notifyCommandDispatched` flips the poller
 * into fast-poll mode for ACTIVE_POLL_WINDOW_MS. Without this the controller's
 * mirror has to wait up to 2s (the idle interval) for a truthful frame after
 * every click, which was the visible "snap back after a second" the user
 * reported on play/pause and volume.
 *
 * The test uses vitest fake timers so the 4s active window doesn't make CI
 * sit waiting. We assert the FIRST post-notify tick lands within ~150ms and
 * subsequent ticks land at ACTIVE_POLL_INTERVAL_MS.
 */
import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionsPoller } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-poller';
import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';

vi.mock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
    remoteTargetApi: {
        listSessionsWithRaw: vi.fn(async () => ({ devices: [], raws: {} })),
    },
}));

const server: ServerListItemWithCredential = {
    credential: 't',
    id: 's',
    name: '',
    type: 'jellyfin' as never,
    url: 'http://x',
    userId: 'u',
    username: '',
} as ServerListItemWithCredential;

describe('SessionsPoller adaptive cadence', () => {
    let poller: SessionsPoller;
    let listMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        vi.useFakeTimers();
        const mod =
            await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
        listMock = mod.remoteTargetApi.listSessionsWithRaw as ReturnType<typeof vi.fn>;
        listMock.mockClear();
        poller = new SessionsPoller();
    });

    afterEach(() => {
        poller.stop();
        useRemoteTargetStore.getState().actions.clearTarget();
        vi.useRealTimers();
    });

    it('fires an immediate first tick on start (so the device list populates synchronously)', async () => {
        poller.start({ onOffline: () => {}, server });
        // The immediate tick is queued microtask; flush.
        await vi.advanceTimersByTimeAsync(0);
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('schedules the next tick at the idle interval (~2s) when no command has been dispatched', async () => {
        poller.start({ onOffline: () => {}, server });
        await vi.advanceTimersByTimeAsync(0); // immediate tick

        // 1500ms — still idle, no extra tick yet.
        await vi.advanceTimersByTimeAsync(1_500);
        expect(listMock).toHaveBeenCalledTimes(1);

        // Cross the 2s boundary — second tick lands.
        await vi.advanceTimersByTimeAsync(600);
        expect(listMock).toHaveBeenCalledTimes(2);
    });

    it('lands a fast-poll tick well under the 2s idle interval after notifyCommandDispatched (regression: snap-back after click)', async () => {
        poller.start({ onOffline: () => {}, server });
        await vi.advanceTimersByTimeAsync(0); // initial tick
        expect(listMock).toHaveBeenCalledTimes(1);

        // Simulate a click → dispatched command.
        poller.notifyCommandDispatched();

        // The dispatcher signal queues a tick at ~150ms — well below the
        // 2s idle cadence. This is what makes the mirror catch up before
        // the optimistic hold expires.
        await vi.advanceTimersByTimeAsync(200);
        expect(listMock).toHaveBeenCalledTimes(2);

        // Subsequent ticks during the active window come at ~400ms.
        await vi.advanceTimersByTimeAsync(500);
        expect(listMock).toHaveBeenCalledTimes(3);
    });

    it('relaxes to the 10s fallback cadence when setFallbackMode(true) is called (push lane healthy)', async () => {
        poller.start({ onOffline: () => {}, server });
        await vi.advanceTimersByTimeAsync(0); // initial tick
        expect(listMock).toHaveBeenCalledTimes(1);

        // Push channel just reported `connected` — poller is now a heartbeat.
        poller.setFallbackMode(true);

        // 5s passes (well past the 2s default but under the 10s fallback) —
        // no new tick must land.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(listMock).toHaveBeenCalledTimes(1);

        // Cross the 10s threshold — fallback heartbeat lands.
        await vi.advanceTimersByTimeAsync(6_000);
        expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it('returns to the 2s cadence when setFallbackMode(false) (push channel dropped)', async () => {
        poller.start({ onOffline: () => {}, server });
        await vi.advanceTimersByTimeAsync(0);
        poller.setFallbackMode(true);
        // Burn time so we're in steady fallback.
        await vi.advanceTimersByTimeAsync(11_000);
        listMock.mockClear();

        // Socket drops — fallback mode off, 2s cadence resumes.
        poller.setFallbackMode(false);
        await vi.advanceTimersByTimeAsync(2_500);
        expect(listMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    });

    it('still bursts active-window polls even while in fallback mode (command dispatched during push)', async () => {
        poller.start({ onOffline: () => {}, server });
        await vi.advanceTimersByTimeAsync(0);
        poller.setFallbackMode(true);
        listMock.mockClear();

        // Command dispatched — the dispatcher fast-poll signal must still
        // burst even though steady state is the 10s heartbeat.
        poller.notifyCommandDispatched();
        await vi.advanceTimersByTimeAsync(200);
        expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('returns to idle cadence after the active window closes', async () => {
        poller.start({ onOffline: () => {}, server });
        await vi.advanceTimersByTimeAsync(0); // initial
        poller.notifyCommandDispatched();

        // Burn through the 4s active window. We don't care about the
        // exact call count here, only that AFTER the window the poller is
        // back on the slow cadence.
        await vi.advanceTimersByTimeAsync(4_500);
        const inWindow = listMock.mock.calls.length;
        listMock.mockClear();

        // Now a 1s wait should yield no new tick (idle is 2s).
        await vi.advanceTimersByTimeAsync(1_000);
        expect(listMock).not.toHaveBeenCalled();
        expect(inWindow).toBeGreaterThan(2); // active window did fire several ticks
    });
});

// The generation guard sits between the awaited listSessionsWithRaw and the
// hand-off to sessionsSink.apply, so spying on apply pins exactly which
// generation's result reaches the store — without depending on the sink's
// internal session→device parsing (and its un-mocked module deps).
describe('SessionsPoller post-await generation guard (C2)', () => {
    let poller: SessionsPoller;
    let listMock: ReturnType<typeof vi.fn>;
    let applySpy: ReturnType<typeof vi.spyOn>;

    const serverA: ServerListItemWithCredential = {
        ...server,
        id: 'srv-A',
    } as ServerListItemWithCredential;
    const serverB: ServerListItemWithCredential = {
        ...server,
        id: 'srv-B',
    } as ServerListItemWithCredential;

    beforeEach(async () => {
        vi.useFakeTimers();
        const mod =
            await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
        listMock = mod.remoteTargetApi.listSessionsWithRaw as ReturnType<typeof vi.fn>;
        listMock.mockReset();
        applySpy = vi.spyOn(sessionsSink, 'apply').mockImplementation(() => {});
        poller = new SessionsPoller();
        useRemoteTargetStore.getState().actions.clearTarget();
    });

    afterEach(() => {
        poller.stop();
        applySpy.mockRestore();
        useRemoteTargetStore.getState().actions.clearTarget();
        vi.useRealTimers();
    });

    const serversAppliedTo = (): string[] =>
        applySpy.mock.calls.map((c) => (c[1] as ServerListItemWithCredential).id);

    it('drops a server-A result that resolves after a stop()+start() restart for server B', async () => {
        const aRaws = { 'sess-A': { DeviceId: 'dev-A', Id: 'sess-A' } };
        const bRaws = { 'sess-B': { DeviceId: 'dev-B', Id: 'sess-B' } };

        // Server A's first poll stays in flight until we release it.
        let releaseA: (v: { devices: never[]; raws: Record<string, unknown> }) => void = () => {};
        const aPending = new Promise<{ devices: never[]; raws: Record<string, unknown> }>(
            (resolve) => {
                releaseA = resolve;
            },
        );

        listMock.mockImplementationOnce(() => aPending); // server A — in flight
        listMock.mockImplementation(async () => ({ devices: [], raws: bRaws })); // server B

        // Start against server A; its immediate tick begins awaiting.
        poller.start({ onOffline: () => {}, server: serverA });
        await vi.advanceTimersByTimeAsync(0);
        expect(applySpy).not.toHaveBeenCalled(); // A hasn't resolved yet

        // Server switch: cleanup stop() then start() against server B (a
        // fresh PollerStartArgs literal — distinct identity from A's).
        poller.stop();
        poller.start({ onOffline: () => {}, server: serverB });
        await vi.advanceTimersByTimeAsync(0);
        // B's tick resolved and applied.
        expect(serversAppliedTo()).toEqual(['srv-B']);

        // Now server A's stale poll finally resolves. The post-await
        // generation guard must drop it — apply is never called with A.
        releaseA({ devices: [], raws: aRaws } as never);
        await vi.advanceTimersByTimeAsync(0);

        expect(serversAppliedTo()).toEqual(['srv-B']);
        expect(serversAppliedTo()).not.toContain('srv-A');
    });

    it('applies a normal single-server tick after the guard (no regression)', async () => {
        listMock.mockImplementation(async () => ({
            devices: [],
            raws: { 'sess-X': { DeviceId: 'dev-X', Id: 'sess-X' } },
        }));

        poller.start({ onOffline: () => {}, server: serverA });
        await vi.advanceTimersByTimeAsync(0);

        expect(applySpy).toHaveBeenCalledTimes(1);
        expect(serversAppliedTo()).toEqual(['srv-A']);
    });
});
