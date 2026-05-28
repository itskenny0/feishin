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
