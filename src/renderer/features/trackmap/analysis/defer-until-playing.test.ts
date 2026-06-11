/**
 * The trackmap analysis used to start the moment the song changed — its
 * full-file download + decode raced the playback stream for bandwidth/CPU
 * exactly at click time, inflating click-to-sound latency (device,
 * 2026-06-11). waitForPlaybackFlowing defers analysis until sound is
 * actually flowing (or a cap elapses, so paused queue loads still get a
 * trackmap eventually).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForPlaybackFlowing } from '/@/renderer/features/trackmap/analysis/defer-until-playing';
import { PlayerStatus } from '/@/shared/types/types';

const mocks = vi.hoisted(() => ({
    playerState: {
        getCurrentSong: () => ({ id: 'song-1' }),
        player: { status: 'paused' as string },
    },
    playerSubscribers: new Set<() => void>(),
    timestampState: { timestamp: 0 },
    timestampSubscribers: new Set<() => void>(),
}));

vi.mock('/@/renderer/store/player.store', () => ({
    usePlayerStoreBase: {
        getState: () => mocks.playerState,
        subscribe: (cb: () => void) => {
            mocks.playerSubscribers.add(cb);
            return () => mocks.playerSubscribers.delete(cb);
        },
    },
}));

vi.mock('/@/renderer/store/timestamp.store', () => ({
    useTimestampStoreBase: {
        getState: () => mocks.timestampState,
        subscribe: (cb: () => void) => {
            mocks.timestampSubscribers.add(cb);
            return () => mocks.timestampSubscribers.delete(cb);
        },
    },
}));

const setPlaying = (timestamp: number) => {
    mocks.playerState.player.status = PlayerStatus.PLAYING;
    mocks.timestampState.timestamp = timestamp;
    mocks.playerSubscribers.forEach((cb) => cb());
    mocks.timestampSubscribers.forEach((cb) => cb());
};

describe('waitForPlaybackFlowing', () => {
    beforeEach(() => {
        vi.useRealTimers();
        mocks.playerState.player.status = 'paused';
        mocks.playerState.getCurrentSong = () => ({ id: 'song-1' });
        mocks.timestampState.timestamp = 0;
        mocks.playerSubscribers.clear();
        mocks.timestampSubscribers.clear();
    });

    it('resolves immediately when the song is already audibly playing', async () => {
        setPlaying(2.5);
        const started = Date.now();
        await waitForPlaybackFlowing({ maxWaitMs: 5000, songId: 'song-1' });
        expect(Date.now() - started).toBeLessThan(100);
    });

    it('waits until playback starts flowing, then resolves', async () => {
        const promise = waitForPlaybackFlowing({ maxWaitMs: 5000, songId: 'song-1' });
        let resolved = false;
        void promise.then(() => {
            resolved = true;
        });
        await new Promise((r) => setTimeout(r, 50));
        expect(resolved).toBe(false);

        setPlaying(0.6);
        await promise;
    });

    it('resolves after the cap even if playback never starts (paused queue load)', async () => {
        const started = Date.now();
        await waitForPlaybackFlowing({ maxWaitMs: 120, songId: 'song-1' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    });

    it('rejects with AbortError when the signal aborts (song skipped)', async () => {
        const ac = new AbortController();
        const promise = waitForPlaybackFlowing({
            maxWaitMs: 5000,
            signal: ac.signal,
            songId: 'song-1',
        });
        ac.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('does not resolve on another song reaching playback', async () => {
        mocks.playerState.getCurrentSong = () => ({ id: 'other-song' });
        const promise = waitForPlaybackFlowing({ maxWaitMs: 150, songId: 'song-1' });
        let resolved = false;
        void promise.then(() => {
            resolved = true;
        });
        setPlaying(3);
        await new Promise((r) => setTimeout(r, 60));
        expect(resolved).toBe(false); // only the cap may release it
        await promise;
    });
});
