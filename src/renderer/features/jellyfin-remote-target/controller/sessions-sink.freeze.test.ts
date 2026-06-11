// Freeze regression (2026-06-11): an Android phone acting as an MQTT remote
// CONTROLLER hard-froze after ~2.5 minutes of mirroring a desktop peer. The
// sessions-socket pushes a /Sessions frame every ~2s; the sink fed every such
// frame through `mirrorSession`, which normalizes the session's embedded
// `NowPlayingItem`. That embedded item never carries `MediaSources`, so each
// frame logged "Jellyfin song retrieved with no media sources" — once per
// frame — and the resulting mirror was then ENTIRELY DISCARDED because MQTT
// owns the lane. With remote-debug shipping on, each warn line is
// JSON-stringified and written through to a localStorage ring on the main
// thread twice a second, on top of the 1Hz MQTT applies.
//
// The fix short-circuits the MQTT-owned lane BEFORE `mirrorSession` runs, so
// the per-frame normalization (and its warn) never happens; the now-playing
// track is resolved once per track CHANGE by the MQTT lane's hydration cache.
//
// This test pins: N identical sessions-frames while MQTT owns the lane cause
// ZERO per-frame song normalizations (no warn, no hydrate) — and the
// connection bookkeeping (status → connected) still runs.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionsSink } from '/@/renderer/features/jellyfin-remote-target/controller/sessions-sink';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { ServerListItemWithCredential, ServerType } from '/@/shared/types/domain-types';

// Drive the lane decision deterministically. Default → 'jellyfin' (so the
// other sink tests are unaffected); each test flips this to 'mqtt' as needed.
const transportMock = vi.hoisted(() => ({ kind: 'jellyfin' as 'jellyfin' | 'mqtt' }));

vi.mock('/@/renderer/features/peer-sync/controller/transport-selector', async () => {
    const actual = await vi.importActual<
        typeof import('/@/renderer/features/peer-sync/controller/transport-selector')
    >('/@/renderer/features/peer-sync/controller/transport-selector');
    return {
        ...actual,
        pickTransportByJellyfinDeviceId: () => transportMock.kind,
    };
});

vi.mock('/@/renderer/features/jellyfin-remote-target/api/remote-target-api', async () => {
    const actual = await vi.importActual<
        typeof import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api')
    >('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
    return {
        ...actual,
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
    };
});

const fakeServer = {
    credential: 'tok',
    id: 'srv',
    name: 'Demo',
    type: ServerType.JELLYFIN,
    url: 'https://example',
    userId: 'u1',
    username: 'demo',
} as unknown as ServerListItemWithCredential;

// A /Sessions row whose embedded NowPlayingItem has NO MediaSources — exactly
// what the live phone saw for "Upgrade" (9f4a93aa...) every 2s.
const frame = (trackId: string) => ({
    Capabilities: { SupportsMediaControl: true },
    Client: 'Jellyfin Web',
    DeviceId: 'dev-1',
    DeviceName: 'Desktop Peer',
    Id: 'sess-dev-1',
    LastActivityDate: '2026-06-11T19:30:00Z',
    NowPlayingItem: { Container: 'flac', Id: trackId, Name: 'Upgrade' },
    NowPlayingQueue: [{ Id: trackId }, { Id: 'q-2' }, { Id: 'q-3' }],
    PlayState: { IsPaused: false, PositionTicks: 0 },
    SupportedCommands: [],
    SupportsMediaControl: true,
    SupportsRemoteControl: true,
});

describe('sessionsSink — MQTT-owned lane does not re-normalize per frame (freeze fix)', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        sessionsSink.reset();
        transportMock.kind = 'mqtt';
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Desktop Peer',
            sessionId: 'sess-dev-1',
        });
    });

    afterEach(() => {
        transportMock.kind = 'jellyfin';
        useRemoteTargetStore.getState().actions.clearTarget();
        sessionsSink.reset();
        vi.restoreAllMocks();
    });

    it('N identical frames with the same trackId → ZERO song normalizations and ZERO hydrates', async () => {
        const apiModule =
            await import('/@/renderer/features/jellyfin-remote-target/api/remote-target-api');
        const hydrateSpy = apiModule.remoteTargetApi.hydrateSongs as ReturnType<typeof vi.fn>;

        // 150 frames ≈ 5 minutes of 2Hz session pushes on the same track.
        for (let i = 0; i < 150; i += 1) {
            sessionsSink.apply([frame('9f4a93aa')], fakeServer);
        }
        await new Promise((res) => setTimeout(res, 0));

        // The "no media sources" warn must NOT fire per frame: mirrorSession
        // (and the normalize inside it) is skipped entirely in MQTT mode.
        const noMediaWarns = warnSpy.mock.calls.filter((c) =>
            String(c[0]).includes('no media sources'),
        );
        expect(noMediaWarns).toHaveLength(0);

        // And the Jellyfin queue hydrate never runs while MQTT owns the queue.
        expect(hydrateSpy).not.toHaveBeenCalled();
    });

    it('still promotes the target to connected from the session bookkeeping', () => {
        expect(useRemoteTargetStore.getState().status).not.toBe('connected');
        sessionsSink.apply([frame('9f4a93aa')], fakeServer);
        expect(useRemoteTargetStore.getState().status).toBe('connected');
    });
});
