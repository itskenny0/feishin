/**
 * Integration test: in-memory fake MQTT lane (no real broker) verifying
 *
 *  - dispatching via `peerDispatcher` when MQTT is the chosen lane produces
 *    a publish on the right topic with a decodable PeerCommand payload, and
 *
 *  - an incoming retained state frame propagates into the remote-target
 *    store via `applyPeerStateToStore`.
 *
 * We don't boot a real broker — we replace the `peer-client` publish path
 * with a spy so the dispatcher's MQTT lane is observable. The transport
 * selector is driven explicitly with `recordPresence` to flip the lane.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { peerDispatcher } from '/@/renderer/features/peer-sync/controller/peer-dispatcher';
import { applyPeerStateToStore } from '/@/renderer/features/peer-sync/controller/peer-state-mirror';
import {
    __resetForTests,
    recordPresence,
    setSyncEnabled,
} from '/@/renderer/features/peer-sync/controller/transport-selector';
import { buildState } from '/@/renderer/features/peer-sync/protocol/builders';
import { codec } from '/@/renderer/features/peer-sync/protocol/codec';

// Spy on the publish path. Capture every command attempt for assertion.
const published: Array<{ a?: unknown; k: string; peerId: string }> = [];

vi.mock('/@/renderer/features/peer-sync/controller/peer-client', () => ({
    isPeerClientConnected: () => true,
    publishCommand: vi.fn((target: { peerId: string }, command: { a?: unknown; k: string }) => {
        published.push({ a: command.a, k: command.k, peerId: target.peerId });
    }),
}));

// Stub the Jellyfin command-dispatcher so falling back to that lane is a
// no-op rather than a real HTTP attempt.
const jfCalls: Array<{ k: string }> = [];
vi.mock('/@/renderer/features/jellyfin-remote-target/controller/command-dispatcher', () => ({
    commandDispatcher: {
        next: vi.fn(() => {
            jfCalls.push({ k: 'next' });
            return Promise.resolve();
        }),
        pause: vi.fn(() => {
            jfCalls.push({ k: 'pause' });
            return Promise.resolve();
        }),
        play: vi.fn(() => {
            jfCalls.push({ k: 'play' });
            return Promise.resolve();
        }),
        previous: vi.fn(() => {
            jfCalls.push({ k: 'previous' });
            return Promise.resolve();
        }),
        seek: vi.fn(() => {
            jfCalls.push({ k: 'seek' });
        }),
        setMute: vi.fn(() => {
            jfCalls.push({ k: 'setMute' });
            return Promise.resolve();
        }),
        setRepeat: vi.fn(() => {
            jfCalls.push({ k: 'setRepeat' });
            return Promise.resolve();
        }),
        setShuffle: vi.fn(() => {
            jfCalls.push({ k: 'setShuffle' });
            return Promise.resolve();
        }),
        setVolume: vi.fn(() => {
            jfCalls.push({ k: 'setVolume' });
        }),
        skipToIndex: vi.fn(() => {
            jfCalls.push({ k: 'skipToIndex' });
            return Promise.resolve();
        }),
    },
}));

const fakeCtx = {
    peer: { peerId: 'peer-target', userId: 'user-abc' },
    server: { id: 's' } as never,
    sessionId: 'sess-1',
};

beforeEach(() => {
    published.length = 0;
    jfCalls.length = 0;
    __resetForTests();
    // Re-seed the remote-target store back to its initial mirrored state
    // so an earlier test's stub track doesn't leak into the next case.
    useRemoteTargetStore.setState({
        mirrored: {
            capabilities: [],
            nowPlayingItem: null,
            playState: {
                isMuted: false,
                isPaused: true,
                positionMs: 0,
                positionSampledAt: 0,
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 100,
            },
            queue: [],
            queueIndex: -1,
        },
        targetDeviceId: null,
    });
});

describe('peerDispatcher routing', () => {
    it('publishes via mqtt when sync is enabled and the peer is present', () => {
        setSyncEnabled(true);
        recordPresence('peer-target', true);

        peerDispatcher.pause(fakeCtx);
        peerDispatcher.seek(fakeCtx, 12345);

        expect(published).toEqual([
            { a: undefined, k: 'pause', peerId: 'peer-target' },
            { a: { positionMs: 12345 }, k: 'seek', peerId: 'peer-target' },
        ]);
        expect(jfCalls).toEqual([]);
    });

    it('falls back to jellyfin when presence is missing', () => {
        setSyncEnabled(true);
        // No recordPresence — the peer hasn't announced itself.
        peerDispatcher.pause(fakeCtx);
        peerDispatcher.next(fakeCtx);

        expect(published).toEqual([]);
        expect(jfCalls.map((c) => c.k)).toEqual(['pause', 'next']);
    });

    it('falls back to jellyfin when the master toggle is off', () => {
        // syncEnabled stays false
        recordPresence('peer-target', true);
        peerDispatcher.pause(fakeCtx);
        expect(published).toEqual([]);
        expect(jfCalls).toEqual([{ k: 'pause' }]);
    });

    /**
     * Regression for the audit: the protocol previously only carried the
     * "obvious" verbs (play/pause/seek/volume/shuffle/repeat). `mute` and
     * `playIndex` were the two glaring control-surface gaps — a controller
     * driving an MQTT target could neither toggle mute nor jump to a
     * specific queue index.
     */
    it('publishes mute via mqtt with an args payload', () => {
        setSyncEnabled(true);
        recordPresence('peer-target', true);

        peerDispatcher.setMute(fakeCtx, true);
        peerDispatcher.setMute(fakeCtx, false);

        expect(published).toEqual([
            { a: { mute: true }, k: 'mute', peerId: 'peer-target' },
            { a: { mute: false }, k: 'mute', peerId: 'peer-target' },
        ]);
        expect(jfCalls).toEqual([]);
    });

    it('publishes playIndex via mqtt and falls back to skipToIndex on jellyfin', () => {
        setSyncEnabled(true);
        recordPresence('peer-target', true);

        peerDispatcher.skipToIndex(fakeCtx, 7);
        expect(published).toEqual([{ a: { index: 7 }, k: 'playIndex', peerId: 'peer-target' }]);

        // Now drop presence — verify the jellyfin fallback is wired.
        __resetForTests();
        setSyncEnabled(true);
        peerDispatcher.skipToIndex(fakeCtx, 2);
        expect(jfCalls.map((c) => c.k)).toContain('skipToIndex');
    });
});

describe('applyPeerStateToStore', () => {
    it('mirrors an incoming state frame into the store', () => {
        // Pretend the user picked a target — otherwise applyPeerStateToStore
        // intentionally no-ops to avoid polluting an idle UI.
        useRemoteTargetStore.setState({ targetDeviceId: 'peer-target' });

        const frame = buildState({
            dur: 240_000,
            paused: false,
            pos: 30_000,
            rep: 'all',
            shuf: true,
            track: {
                album: 'OK Computer',
                art: null,
                artist: 'Radiohead',
                id: 'song-1',
                title: 'Paranoid Android',
            },
            vol: 55,
        });

        // Round-trip through the codec so the test path matches the wire path.
        const wire = codec.encode(frame);
        const decoded = codec.decode(wire);
        expect(decoded).not.toBeNull();
        applyPeerStateToStore(decoded as typeof frame);

        const state = useRemoteTargetStore.getState();
        expect(state.mirrored.playState.positionMs).toBe(30_000);
        expect(state.mirrored.playState.isPaused).toBe(false);
        expect(state.mirrored.playState.shuffle).toBe(true);
        expect(state.mirrored.playState.repeatMode).toBe('RepeatAll');
        expect(state.mirrored.playState.volume).toBe(55);
        expect(state.mirrored.nowPlayingItem?.id).toBe('song-1');
        expect(state.mirrored.nowPlayingItem?.name).toBe('Paranoid Android');
    });

    /**
     * Regression: mute and queue-index were added as optional v1+ wire
     * fields. When the publisher includes them, the controller's mirror
     * must surface them; when the publisher omits them, the controller's
     * mirrored mute MUST NOT be flipped from its prior value — otherwise
     * an older publisher would silently un-mute the controller every tick.
     */
    it('mirrors optional mute and queue-index fields when present', () => {
        useRemoteTargetStore.setState({ targetDeviceId: 'peer-target' });

        const frame = buildState({
            dur: 240_000,
            mut: true,
            paused: false,
            pos: 0,
            qIds: ['a', 'b', 'c', 'd', 'e'],
            qIdx: 4,
            rep: 'off',
            shuf: false,
            track: { album: null, art: null, artist: null, id: 'song-x', title: 'x' },
            vol: 50,
        });
        applyPeerStateToStore(frame);
        const state = useRemoteTargetStore.getState();
        expect(state.mirrored.playState.isMuted).toBe(true);
        expect(state.mirrored.queueIndex).toBe(4);
    });

    it('does NOT overwrite isMuted when an older publisher omits the field', () => {
        // Seed the store with isMuted=true so we can prove the absent field
        // doesn't silently flip the mirror back to false.
        useRemoteTargetStore.setState({
            mirrored: {
                capabilities: [],
                nowPlayingItem: null,
                playState: {
                    isMuted: true,
                    isPaused: true,
                    positionMs: 0,
                    positionSampledAt: 0,
                    repeatMode: 'RepeatNone',
                    shuffle: false,
                    volume: 100,
                },
                queue: [],
                queueIndex: -1,
            },
            targetDeviceId: 'peer-target',
        });

        // Frame from a publisher that doesn't emit `mut`.
        const frame = buildState({
            dur: 0,
            paused: true,
            pos: 0,
            rep: 'off',
            shuf: false,
            track: null,
            vol: 100,
        });
        applyPeerStateToStore(frame);
        expect(useRemoteTargetStore.getState().mirrored.playState.isMuted).toBe(true);
    });

    it('is a no-op when no target is selected', () => {
        useRemoteTargetStore.setState({ targetDeviceId: null });

        const frame = buildState({
            dur: 100,
            paused: true,
            pos: 0,
            rep: 'off',
            shuf: false,
            track: null,
            vol: 100,
        });
        applyPeerStateToStore(frame);
        const state = useRemoteTargetStore.getState();
        // Default playState is paused with positionMs=0 — make sure we didn't
        // accidentally seed a stub track.
        expect(state.mirrored.nowPlayingItem).toBeNull();
    });
});
