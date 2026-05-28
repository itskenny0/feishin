import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

const fakeServer = {
    credential: 'tok',
    id: 'srv',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'https://example',
    userId: 'u1',
    username: 'demo',
} as unknown as ServerListItemWithCredential;

vi.mock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', () => ({
    remoteTargetApi: {
        hydrateSongs: vi.fn(async ({ itemIds }: { itemIds: string[] }) =>
            itemIds.map((id) => ({
                id,
                name: id,
                serverId: 'srv',
                streamUrl: '',
                uniqueId: id,
            })),
        ),
    },
}));

const session = (deviceId: string, queueIds: string[]) => ({
    Capabilities: { SupportsMediaControl: true },
    Client: 'Jellyfin Web',
    DeviceId: deviceId,
    DeviceName: 'Demo Session',
    Id: `sess-${deviceId}`,
    LastActivityDate: '2026-01-01T00:00:00Z',
    NowPlayingItem: { Id: queueIds[0] ?? 'none', Name: 'first' },
    NowPlayingQueue: queueIds.map((Id) => ({ Id })),
    PlayState: { IsPaused: false, PositionTicks: 0 },
    SupportedCommands: [],
    SupportsMediaControl: true,
    SupportsRemoteControl: true,
});

describe('sessionsSink truncated-queue caching', () => {
    beforeEach(() => {
        sessionsSink.reset();
        const { actions } = useRemoteTargetStore.getState();
        actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Demo Session',
            sessionId: 'sess-dev-1',
        });
    });

    afterEach(() => {
        useRemoteTargetStore.getState().actions.clearTarget();
        sessionsSink.reset();
        vi.clearAllMocks();
    });

    it('hydrates once and stays quiet on the next tick when an oversized queue is unchanged', async () => {
        const queueIds = Array.from({ length: 250 }, (_, i) => `item-${i}`);
        const apiModule =
            await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
        const hydrateSpy = apiModule.remoteTargetApi.hydrateSongs as ReturnType<typeof vi.fn>;

        sessionsSink.apply([session('dev-1', queueIds)], fakeServer);
        // Wait for the hydrate to resolve.
        await new Promise((res) => setTimeout(res, 0));
        const callsAfterFirst = hydrateSpy.mock.calls.length;
        expect(callsAfterFirst).toBe(1);

        sessionsSink.apply([session('dev-1', queueIds)], fakeServer);
        await new Promise((res) => setTimeout(res, 0));
        // No additional hydrate — the cache should match an oversized,
        // unchanged queue.
        expect(hydrateSpy.mock.calls.length).toBe(callsAfterFirst);
    });

    it('rolls back the queue cache when hydrate rejects so the next tick can retry', async () => {
        const queueIds = Array.from({ length: 250 }, (_, i) => `flaky-${i}`);
        const apiModule =
            await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
        const hydrateSpy = apiModule.remoteTargetApi.hydrateSongs as ReturnType<typeof vi.fn>;

        hydrateSpy.mockImplementationOnce(async () => {
            throw new Error('boom');
        });

        sessionsSink.apply([session('dev-1', queueIds)], fakeServer);
        await new Promise((res) => setTimeout(res, 0));
        expect(hydrateSpy.mock.calls.length).toBe(1);

        // Same payload, but the previous hydrate failed → cache rolled back
        // → second apply must hit hydrate again.
        sessionsSink.apply([session('dev-1', queueIds)], fakeServer);
        await new Promise((res) => setTimeout(res, 0));
        expect(hydrateSpy.mock.calls.length).toBe(2);
    });
});
