import { afterEach, describe, expect, it } from 'vitest';

import {
    DEFAULT_HOLD_MS,
    SEEK_HOLD_MS,
    useRemoteTargetStore,
} from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { Song } from '/@/shared/types/domain-types';

const stubSong = (id: string): Song =>
    ({
        albumArtists: [],
        artistName: id,
        artists: [],
        duration: 200_000,
        id,
        imageUrl: null,
        name: `Song ${id}`,
        path: null,
        serverId: 'srv',
        serverType: 'jellyfin',
        streamUrl: '',
        uniqueId: id,
    }) as unknown as Song;

const connectTarget = (capabilities: string[] = []) =>
    useRemoteTargetStore.getState().actions.setTarget({
        capabilities,
        deviceId: 'dev-1',
        deviceName: 'Living Room',
        sessionId: 'sess-1',
    });

afterEach(() => {
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('optimistic holds — stale-poll guard', () => {
    it('keeps an optimistic pause when a contradicting poll lands inside the hold window (regression: pause icon flicker)', () => {
        connectTarget();
        // Receiver was playing.
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: false,
                positionMs: 30_000,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        // User pauses — optimistic flip + hold.
        useRemoteTargetStore.getState().actions.setPaused(true);
        expect(useRemoteTargetStore.getState().mirrored.playState.isPaused).toBe(true);

        // Stale poll lands carrying pre-pause state.
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: false,
                positionMs: 30_200,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        expect(useRemoteTargetStore.getState().mirrored.playState.isPaused).toBe(true);
    });

    it('clears the hold when the next poll agrees with the optimistic value', () => {
        connectTarget();
        useRemoteTargetStore.getState().actions.setPaused(true);
        expect(useRemoteTargetStore.getState().holds.isPaused?.expected).toBe(true);

        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: true,
                positionMs: 30_000,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        // Server caught up — hold dropped.
        expect(useRemoteTargetStore.getState().holds.isPaused).toBeUndefined();
    });

    it('releases an isPaused hold once it expires so a stuck client can recover', () => {
        connectTarget();
        // Plant a hold that already expired.
        useRemoteTargetStore.getState().actions.hold('isPaused', true, -10);
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: false,
                positionMs: 0,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        expect(useRemoteTargetStore.getState().mirrored.playState.isPaused).toBe(false);
        expect(useRemoteTargetStore.getState().holds.isPaused).toBeUndefined();
    });

    it('positionMs hold tolerates a few hundred ms drift between optimistic seek and the eventual server confirmation', () => {
        connectTarget();
        useRemoteTargetStore.getState().actions.optimisticSeek(90_000);
        // Drift well inside POSITION_HOLD_TOLERANCE_MS — should clear.
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: false,
                positionMs: 91_200,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        expect(useRemoteTargetStore.getState().holds.positionMs).toBeUndefined();
        expect(useRemoteTargetStore.getState().mirrored.playState.positionMs).toBeCloseTo(
            91_200,
            -1,
        );
    });

    it('seek hold survives a contradicting stale poll (regression: seekbar jump-back)', () => {
        connectTarget();
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: false,
                positionMs: 5_000,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        useRemoteTargetStore.getState().actions.optimisticSeek(120_000);
        // Stale poll shows the receiver still at the old spot.
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: false,
                positionMs: 5_500,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        expect(useRemoteTargetStore.getState().mirrored.playState.positionMs).toBe(120_000);
    });

    it("optimisticNext flips nowPlayingItem and rejects a stale poll showing the old song (regression: jumps back to a song that isn't running)", () => {
        connectTarget();
        const a = stubSong('a');
        const b = stubSong('b');
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            nowPlayingItem: a,
            playState: {
                isPaused: false,
                positionMs: 100_000,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
            queue: [a, b],
            queueIndex: 0,
        });
        useRemoteTargetStore.getState().actions.optimisticNext();
        expect(useRemoteTargetStore.getState().mirrored.nowPlayingItem?.id).toBe('b');
        expect(useRemoteTargetStore.getState().mirrored.queueIndex).toBe(1);
        expect(useRemoteTargetStore.getState().mirrored.playState.positionMs).toBe(0);

        // Stale poll insists song A is still playing — the hold rejects it.
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            nowPlayingItem: a,
            playState: {
                isPaused: false,
                positionMs: 100_500,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        expect(useRemoteTargetStore.getState().mirrored.nowPlayingItem?.id).toBe('b');
    });

    it('default hold horizon matches DEFAULT_HOLD_MS and seek uses SEEK_HOLD_MS', () => {
        connectTarget();
        const before = Date.now();
        useRemoteTargetStore.getState().actions.setPaused(true);
        const pauseHold = useRemoteTargetStore.getState().holds.isPaused;
        expect(pauseHold).toBeDefined();
        expect(pauseHold!.until - before).toBeGreaterThanOrEqual(DEFAULT_HOLD_MS - 50);
        expect(pauseHold!.until - before).toBeLessThanOrEqual(DEFAULT_HOLD_MS + 50);

        useRemoteTargetStore.getState().actions.optimisticSeek(10_000);
        const seekHold = useRemoteTargetStore.getState().holds.positionMs;
        expect(seekHold).toBeDefined();
        expect(seekHold!.until - before).toBeGreaterThanOrEqual(SEEK_HOLD_MS - 50);
    });

    it('hold horizon is at least 6s so a 2s/3s server convergence does not snap back (regression: flicker-back after hold expiry)', () => {
        // Real bug: the old hold window was 2s, but a /Sessions poll fires
        // every 2s AND the receiver only writes PlaybackProgress every 3s.
        // The hold expired between the user's click and the truthful state
        // landing, so the next stale poll would clobber the optimistic
        // value with the pre-command snapshot. Pin the floor at 6s so the
        // failure mode can't sneak back in via a constant tweak.
        expect(DEFAULT_HOLD_MS).toBeGreaterThanOrEqual(6_000);
        expect(SEEK_HOLD_MS).toBeGreaterThanOrEqual(6_000);
    });

    it('patchPlayState installs holds for every patched field so optimistic updates stick', () => {
        connectTarget();
        useRemoteTargetStore.getState().actions.patchPlayState({
            repeatMode: 'RepeatAll',
            shuffle: true,
            volume: 73,
        });
        const holds = useRemoteTargetStore.getState().holds;
        expect(holds.volume?.expected).toBe(73);
        expect(holds.repeatMode?.expected).toBe('RepeatAll');
        expect(holds.shuffle?.expected).toBe(true);

        // Stale poll trying to reset all three to their old values — rejected.
        useRemoteTargetStore.getState().actions.applyMirrorFromServer({
            playState: {
                isPaused: true,
                positionMs: 0,
                positionSampledAt: Date.now(),
                repeatMode: 'RepeatNone',
                shuffle: false,
                volume: 50,
            },
        });
        const ps = useRemoteTargetStore.getState().mirrored.playState;
        expect(ps.volume).toBe(73);
        expect(ps.repeatMode).toBe('RepeatAll');
        expect(ps.shuffle).toBe(true);
    });
});
