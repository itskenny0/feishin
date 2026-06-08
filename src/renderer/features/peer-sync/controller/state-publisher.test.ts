/**
 * Outbound state publisher (D1 / SEV-2).
 *
 * Pins the contract that:
 *   1. starting the publisher emits an initial retained `state` frame and a
 *      subsequent player mutation publishes another;
 *   2. the loop guard suppresses a publish during an inbound-apply window;
 *   3. an edge change (pause/track) bypasses the throttle and publishes
 *      immediately;
 *   4. qIds/qIdx are emitted in DEFAULT order (SEV-3);
 *   5. a published frame round-trips codec → applyPeerStateToStore (e2e).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { codec } from '/@/renderer/features/peer-sync/protocol/codec';
import { PeerState } from '/@/renderer/features/peer-sync/types';

// Capture publishOwnState while letting isPeerClientConnected report "up". The
// mock mirrors the REAL publishOwnState's loop-guard chokepoint so the
// suppression-during-inbound-apply test is meaningful (the real client drops
// the publish when isInboundApplyActive()).
const publishedFrames: PeerState[] = [];
vi.mock('/@/renderer/features/peer-sync/controller/peer-client', async () => {
    const { isInboundApplyActive } =
        await import('/@/renderer/features/peer-sync/controller/peer-loop-guard');
    return {
        isPeerClientConnected: () => true,
        publishOwnState: (state: PeerState) => {
            if (isInboundApplyActive()) return;
            publishedFrames.push(state);
        },
    };
});

import {
    __resetInboundApply,
    markInboundApply,
} from '/@/renderer/features/peer-sync/controller/peer-loop-guard';
import {
    __isStatePublisherRunning,
    PUBLISH_THROTTLE_MS,
    startStatePublisher,
    stopStatePublisher,
} from '/@/renderer/features/peer-sync/controller/state-publisher';
import {
    __resetForTests as resetTransportSelector,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { PlayerStatus } from '/@/shared/types/types';

const stubSong = (id: string, uniqueId: string) =>
    ({
        _uniqueId: uniqueId,
        album: 'Album',
        albumArtists: [{ id: 'a', imageUrl: null, name: 'Artist' }],
        artistName: 'Artist',
        artists: [],
        duration: 200,
        id,
        imageUrl: 'http://art/x.jpg',
        name: `Track ${id}`,
    }) as never;

const seedQueue = (status = PlayerStatus.PLAYING) => {
    // Three-track default-order queue with index 1 current.
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: 1, status },
        queue: {
            ...s.queue,
            default: ['u0', 'u1', 'u2'],
            shuffled: [],
            songs: {
                u0: stubSong('song-0', 'u0'),
                u1: stubSong('song-1', 'u1'),
                u2: stubSong('song-2', 'u2'),
            },
        },
    }));
    useTimestampStoreBase.setState({ timestamp: 12 });
};

beforeEach(() => {
    publishedFrames.length = 0;
    __resetInboundApply();
    resetTransportSelector();
    setSyncEnabled(true);
    seedQueue();
});

afterEach(() => {
    stopStatePublisher();
    __resetInboundApply();
    resetTransportSelector();
    vi.useRealTimers();
});

describe('state-publisher', () => {
    it('emits an initial retained frame on start and is idempotent', () => {
        startStatePublisher();
        expect(__isStatePublisherRunning()).toBe(true);
        expect(publishedFrames.length).toBe(1);
        const f = publishedFrames[0];
        expect(f.t).toBe('state');
        expect(f.paused).toBe(false);
        expect(f.track?.id).toBe('song-1');
        // `dur` is the track's ms duration verbatim — NOT scaled again (the
        // store already holds ms). Same unit as `pos`. Regression guard for the
        // ms×1000 duration that rendered as ~2:04:06:24 on the controller.
        expect(f.dur).toBe(200);
        // A second start does not re-subscribe / double-publish.
        startStatePublisher();
        expect(publishedFrames.length).toBe(1);
    });

    it('emits qIds/qIdx in DEFAULT order (SEV-3)', () => {
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.qIds).toEqual(['song-0', 'song-1', 'song-2']);
        // Current song is at default index 1.
        expect(f.qIdx).toBe(1);
    });

    it('emits a default-order qIdx even with shuffle on', () => {
        // Shuffle on, shuffled order reverses the queue. player.index points
        // into the shuffled order; getCurrentSong maps it back to default.
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, index: 0, shuffle: 'track' as never },
            queue: { ...s.queue, shuffled: [2, 1, 0] },
        }));
        startStatePublisher();
        const f = publishedFrames[0];
        // shuffled[0] === 2 → default-order song-2 is current → default idx 2.
        expect(f.track?.id).toBe('song-2');
        expect(f.qIdx).toBe(2);
        expect(f.qIds).toEqual(['song-0', 'song-1', 'song-2']);
    });

    it('publishes again on a player mutation (track change)', () => {
        startStatePublisher();
        expect(publishedFrames.length).toBe(1);
        // Move to track 2 — an edge change.
        usePlayerStoreBase.setState((s) => ({ ...s, player: { ...s.player, index: 2 } }));
        expect(publishedFrames.length).toBe(2);
        expect(publishedFrames[1].track?.id).toBe('song-2');
    });

    it('edge-publishes immediately on pause/resume (bypasses throttle)', () => {
        vi.useFakeTimers();
        startStatePublisher();
        const before = publishedFrames.length;
        // Pause is an edge → immediate publish, no throttle wait.
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, status: PlayerStatus.PAUSED },
        }));
        expect(publishedFrames.length).toBe(before + 1);
        expect(publishedFrames[publishedFrames.length - 1].paused).toBe(true);
    });

    it('throttles position-only updates to ~2 Hz with a trailing publish', () => {
        vi.useFakeTimers();
        startStatePublisher(); // initial publish at t0
        const baseline = publishedFrames.length;
        // Rapid position ticks (no edge change) within the throttle window.
        for (let i = 1; i <= 5; i += 1) {
            useTimestampStoreBase.setState({ timestamp: 12 + i });
        }
        // No immediate extra publish — they're throttled behind the window.
        expect(publishedFrames.length).toBe(baseline);
        // The trailing timer fires once after the window with the latest value.
        vi.advanceTimersByTime(PUBLISH_THROTTLE_MS + 10);
        expect(publishedFrames.length).toBe(baseline + 1);
        expect(publishedFrames[publishedFrames.length - 1].pos).toBe(17_000);
    });

    it('suppresses publishing while the inbound-apply loop guard is active', () => {
        startStatePublisher();
        const before = publishedFrames.length;
        // Simulate the receiver applying an inbound command: open the guard,
        // then mutate the store the way an applied command would. publishOwnState
        // (here and in the real client) consults isInboundApplyActive and drops
        // the publish, so the edge change must NOT add a frame.
        markInboundApply();
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, status: PlayerStatus.PAUSED },
        }));
        expect(publishedFrames.length).toBe(before);
        // Once the guard window closes, a fresh mutation publishes normally.
        __resetInboundApply();
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, status: PlayerStatus.PLAYING },
        }));
        expect(publishedFrames.length).toBe(before + 1);
    });

    it('round-trips a published frame through codec → applyPeerStateToStore (e2e)', async () => {
        startStatePublisher();
        const frame = publishedFrames[0];
        // Encode → decode exactly as the wire would.
        const decoded = codec.decode(codec.encode(frame));
        expect(decoded).not.toBeNull();
        expect(decoded?.t).toBe('state');

        // Feed it into the mirror. Set up a target + fresh peer bridge so the
        // gates pass, then assert the mirror reflects the published track.
        const { useRemoteTargetStore } =
            await import('/@/renderer/features/jellyfin-remote-target/store/remote-target-store');
        const { recordPresence } =
            await import('/@/renderer/features/peer-sync/controller/transport-selector');
        const { applyPeerStateToStore } =
            await import('/@/renderer/features/peer-sync/controller/peer-state-mirror');

        recordPresence('peer-remote', true, Date.now(), 'jf-dev-remote');
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'jf-dev-remote',
            deviceName: 'Remote',
            sessionId: 'sess',
        });

        applyPeerStateToStore({ peerId: 'peer-remote', userId: 'u' }, decoded as PeerState);
        const mirrored = useRemoteTargetStore.getState().mirrored;
        expect(mirrored.nowPlayingItem?.id).toBe('song-1');
        expect(mirrored.playState.isPaused).toBe(false);
    });
});
