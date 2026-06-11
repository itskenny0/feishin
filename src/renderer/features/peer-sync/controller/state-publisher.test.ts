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
        publishOwnState: (state: PeerState): boolean => {
            // Mirror the real client's contract: return false (and publish
            // nothing) while the inbound-apply window is open.
            if (isInboundApplyActive()) return false;
            publishedFrames.push(state);
            return true;
        },
    };
});

import {
    __resetInboundApply,
    INBOUND_APPLY_WINDOW_MS,
    markInboundApply,
} from '/@/renderer/features/peer-sync/controller/peer-loop-guard';
import {
    __isStatePublisherRunning,
    deriveUpcomingTrackIds,
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
import { PlayerRepeat, PlayerStatus } from '/@/shared/types/types';

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

    it('emits the default-order next track id as nxt with shuffle off (BUG 1)', () => {
        // Seeded queue: index 1 (song-1), repeat off → next is song-2.
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.nxt).toBe('song-2');
    });

    it('emits the SHUFFLE-resolved next track id as nxt, not the default neighbour (BUG 1)', () => {
        // Shuffle on, shuffled order [2,1,0], player.index 0 → current is
        // default song-2. The DEFAULT-order neighbour after song-2 would be
        // nothing (last in default order), but the SHUFFLE next is shuffled[1]
        // === 1 → song-1. nxt must report the shuffle-resolved track.
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, index: 0, shuffle: 'track' as never },
            queue: { ...s.queue, shuffled: [2, 1, 0] },
        }));
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.track?.id).toBe('song-2');
        expect(f.nxt).toBe('song-1');
    });

    it('emits nxt=null at the end of the queue with repeat off (BUG 1)', () => {
        // Move current to the last default-order track; repeat off → no next.
        usePlayerStoreBase.setState((s) => ({ ...s, player: { ...s.player, index: 2 } }));
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.track?.id).toBe('song-2');
        expect(f.nxt).toBeNull();
    });

    // BUG (shuffle up-next): the publisher must ship the TRUE upcoming sequence
    // in `nxts`, not the default-order neighbours.
    it('emits the default-order upcoming sequence as nxts with shuffle off', () => {
        // Seeded: index 1 (song-1), repeat off → upcoming is just song-2.
        // Pin shuffle off explicitly — seedQueue preserves the prior player's
        // shuffle flag, so a preceding shuffle-on test would otherwise leak.
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, shuffle: 'none' as never },
        }));
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.nxts).toEqual(['song-2']);
        // nxts[0] stays consistent with nxt.
        expect(f.nxts?.[0]).toBe(f.nxt);
    });

    it('emits the SHUFFLE-resolved upcoming sequence as nxts (not default neighbours)', () => {
        // Shuffle on, shuffled order [2,1,0], player.index 0 → current song-2.
        // Playback order after the current is shuffled[1]=1 (song-1),
        // shuffled[2]=0 (song-0). Default-order neighbours of song-2 would be
        // nothing — nxts must report the shuffle sequence.
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, index: 0, shuffle: 'track' as never },
            queue: { ...s.queue, shuffled: [2, 1, 0] },
        }));
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.track?.id).toBe('song-2');
        expect(f.nxts).toEqual(['song-1', 'song-0']);
        expect(f.nxts?.[0]).toBe(f.nxt);
    });

    it('omits nxts at the end of the queue with repeat off', () => {
        // Last default-order track, repeat off → nothing upcoming → field omitted.
        usePlayerStoreBase.setState((s) => ({ ...s, player: { ...s.player, index: 2 } }));
        startStatePublisher();
        const f = publishedFrames[0];
        expect(f.track?.id).toBe('song-2');
        expect('nxts' in f).toBe(false);
    });

    describe('deriveUpcomingTrackIds (pure)', () => {
        const idOf = (u: string) => ({ u0: 'song-0', u1: 'song-1', u2: 'song-2' })[u];
        const base = {
            defaultIds: ['u0', 'u1', 'u2'],
            songIdByUniqueId: idOf as (u: string) => string | undefined,
        };

        it('returns the default-order tail when shuffle is off (repeat off)', () => {
            expect(
                deriveUpcomingTrackIds({
                    ...base,
                    playerIndex: 0,
                    repeat: PlayerRepeat.NONE,
                    shuffled: [],
                    shuffleOn: false,
                }),
            ).toEqual(['song-1', 'song-2']);
        });

        it('walks the shuffled order when shuffle is on', () => {
            // shuffled [2,1,0], current playback pos 0 → next pos 1 (default idx
            // 1 → song-1), pos 2 (default idx 0 → song-0).
            expect(
                deriveUpcomingTrackIds({
                    ...base,
                    playerIndex: 0,
                    repeat: PlayerRepeat.NONE,
                    shuffled: [2, 1, 0],
                    shuffleOn: true,
                }),
            ).toEqual(['song-1', 'song-0']);
        });

        it('wraps to the front under repeat=all but never repeats the current item', () => {
            // default order, index 1, repeat all → song-2, then wrap to song-0,
            // stop before looping back onto the current (song-1).
            expect(
                deriveUpcomingTrackIds({
                    ...base,
                    playerIndex: 1,
                    repeat: PlayerRepeat.ALL,
                    shuffled: [],
                    shuffleOn: false,
                }),
            ).toEqual(['song-2', 'song-0']);
        });

        it('returns [] for repeat=one (current track replays)', () => {
            expect(
                deriveUpcomingTrackIds({
                    ...base,
                    playerIndex: 0,
                    repeat: PlayerRepeat.ONE,
                    shuffled: [],
                    shuffleOn: false,
                }),
            ).toEqual([]);
        });

        it('honours the limit', () => {
            expect(
                deriveUpcomingTrackIds({
                    ...base,
                    limit: 1,
                    playerIndex: 0,
                    repeat: PlayerRepeat.NONE,
                    shuffled: [],
                    shuffleOn: false,
                }),
            ).toEqual(['song-1']);
        });
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
        // Once the guard window closes, a fresh edge mutation publishes
        // normally. (Use a track change — a distinct edge from the last
        // PUBLISHED frame. Returning to PLAYING would not be an edge now that
        // suppression correctly leaves lastEdge at the last sent state.)
        __resetInboundApply();
        usePlayerStoreBase.setState((s) => ({ ...s, player: { ...s.player, index: 2 } }));
        expect(publishedFrames.length).toBe(before + 1);
        expect(publishedFrames[publishedFrames.length - 1].track?.id).toBe('song-2');
    });

    it('re-publishes the settled state after the inbound-apply window closes (no snap-back)', () => {
        vi.useFakeTimers();
        startStatePublisher();
        const before = publishedFrames.length;
        // Receiver applies an inbound pause from a controller: open the guard,
        // then mutate the store the way mediaPause() would.
        markInboundApply();
        usePlayerStoreBase.setState((s) => ({
            ...s,
            player: { ...s.player, status: PlayerStatus.PAUSED },
        }));
        // Suppressed during the window — nothing on the wire yet.
        expect(publishedFrames.length).toBe(before);
        // Regression: the publisher must re-emit the SETTLED paused state once
        // the window closes WITHOUT any further local mutation. Before the fix,
        // publishNow advanced lastEdge while suppressed, so the paused frame was
        // never sent and the controller's mirror snapped back to our stale
        // (playing) retained frame when its optimistic hold expired.
        vi.advanceTimersByTime(INBOUND_APPLY_WINDOW_MS + 30);
        expect(publishedFrames.length).toBe(before + 1);
        expect(publishedFrames[publishedFrames.length - 1].paused).toBe(true);
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
