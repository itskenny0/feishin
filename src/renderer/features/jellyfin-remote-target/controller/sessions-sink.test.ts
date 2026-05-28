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

    /**
     * Audit regression: `IsMuted` from a /Sessions snapshot must surface in
     * the store's mirrored play-state. Before the fix, the controller's
     * mute toggle silently disagreed with the target whenever the target
     * was muted but non-zero volume.
     */
    it('mirrors IsMuted from the session payload into the store', async () => {
        const sess = session('dev-1', ['only-track']);
        // Override the PlayState the helper builds so we exercise mute.
        sess.PlayState = { IsMuted: true, IsPaused: false, PositionTicks: 0 } as never;

        sessionsSink.apply([sess], fakeServer);
        await new Promise((res) => setTimeout(res, 0));

        const state = useRemoteTargetStore.getState();
        expect(state.mirrored.playState.isMuted).toBe(true);
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

/**
 * The sessions-sink is the shared seam between the poll path and the WS push
 * path — both feed `apply()` and rely on it to produce structurally identical
 * store updates. Regressions in this seam have shipped as "the picker shows
 * the device but the now-playing UI is empty" / "selecting a device works on
 * the next poll but not when the push lands first". These tests lock in the
 * invariants that matter for end-to-end Connect behaviour.
 */

const server: ServerListItemWithCredential = {
    credential: 'cred',
    id: 'srv-1',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'https://example.test',
    userId: 'user-1',
    username: 'demo',
};

const sessionRow = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
    Capabilities: { SupportsMediaControl: true },
    Client: 'Jellyfin Web',
    DeviceId: 'dev-living-room',
    DeviceName: 'Living Room',
    Id: 'sess-1',
    LastActivityDate: '2024-01-01T00:00:00Z',
    NowPlayingItem: null,
    PlayState: { IsPaused: false, PositionTicks: 0, RepeatMode: 'RepeatNone', VolumeLevel: 60 },
    SupportedCommands: ['SetVolume', 'SetRepeatMode'],
    SupportsMediaControl: true,
    SupportsRemoteControl: true,
    ...over,
});

beforeEach(() => {
    sessionsSink.reset();
    useRemoteTargetStore.getState().actions.clearTarget();
    useRemoteTargetStore.setState({ deviceList: [], hasPolledOnce: false, pollError: 'previous' });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('sessionsSink.apply — device list', () => {
    it('populates deviceList from valid rows and clears any prior pollError', () => {
        sessionsSink.apply([sessionRow()], server);
        const state = useRemoteTargetStore.getState();
        expect(state.deviceList).toHaveLength(1);
        expect(state.deviceList[0].deviceId).toBe('dev-living-room');
        expect(state.deviceList[0].sessionId).toBe('sess-1');
        expect(state.pollError).toBeNull();
        expect(state.hasPolledOnce).toBe(true);
    });

    it('drops malformed rows instead of poisoning the list', () => {
        sessionsSink.apply(
            [
                null,
                'nope',
                { DeviceId: 'no-session-id' },
                { Id: 'no-device-id' },
                sessionRow({ DeviceId: 'd2', Id: 's2' }),
            ],
            server,
        );
        const list = useRemoteTargetStore.getState().deviceList;
        expect(list).toHaveLength(1);
        expect(list[0].deviceId).toBe('d2');
    });
});

describe('sessionsSink.apply — target reconciliation', () => {
    it('does no target work when there is no target selected', () => {
        sessionsSink.apply([sessionRow()], server);
        const state = useRemoteTargetStore.getState();
        expect(state.sessionId).toBeNull();
        expect(state.status).toBe('idle');
    });

    it('updates sessionId via reconcileSession when the target reappears with a new session', () => {
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-living-room',
            deviceName: 'Living Room',
            sessionId: '__pending__',
        });
        sessionsSink.apply([sessionRow({ Id: 'sess-fresh' })], server);
        const state = useRemoteTargetStore.getState();
        expect(state.sessionId).toBe('sess-fresh');
        expect(state.targetDeviceId).toBe('dev-living-room');
        // reconcileSession should not wipe the user-visible name.
        expect(state.targetDeviceName).toBe('Living Room');
        expect(state.mirrored.capabilities).toEqual(['SetVolume', 'SetRepeatMode']);
    });

    it('leaves status untouched when the target device is missing from the snapshot — only the poller decides reconnecting→offline', () => {
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-living-room',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        // setTarget moves us to 'connected'. A push that doesn't include this
        // device must NOT downgrade to 'reconnecting' — that's the poller's
        // responsibility because the poller alone knows about time.
        sessionsSink.apply([sessionRow({ DeviceId: 'other-dev', Id: 'sess-other' })], server);
        expect(useRemoteTargetStore.getState().status).toBe('connected');
    });

    it('mirrors playState from the matching session without disturbing optimistic holds', () => {
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-living-room',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        // User just locally bumped the volume optimistically.
        useRemoteTargetStore.getState().actions.patchPlayState({ volume: 88 });

        // A stale push lands with the pre-bump volume.
        sessionsSink.apply(
            [
                sessionRow({
                    PlayState: {
                        IsPaused: false,
                        PositionTicks: 0,
                        RepeatMode: 'RepeatNone',
                        VolumeLevel: 60,
                    },
                }),
            ],
            server,
        );

        // Hold protects the optimistic value.
        expect(useRemoteTargetStore.getState().mirrored.playState.volume).toBe(88);
    });
});
