import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { PlayerStatus } from '/@/shared/types/types';

/** Sound is considered flowing once the clock has advanced past this. */
const AUDIBLE_THRESHOLD_SEC = 0.5;

/**
 * Resolve once playback of `songId` is audibly under way — or after
 * `maxWaitMs` as a cap so a paused queue restore still gets its trackmap.
 *
 * The trackmap analysis downloads and decodes the WHOLE source file; started
 * at song-change time it competes with the playback stream for bandwidth and
 * CPU at exactly the moment the user is waiting for sound (click-to-sound
 * latency, device 2026-06-11). Callers await this before analyzeSong so the
 * stream always wins the start.
 */
export const waitForPlaybackFlowing = (args: {
    maxWaitMs: number;
    signal?: AbortSignal;
    songId: string;
}): Promise<void> => {
    const { maxWaitMs, signal, songId } = args;

    const isFlowing = (): boolean => {
        const player = usePlayerStoreBase.getState();
        if (player.getCurrentSong()?.id !== songId) return false;
        if (player.player.status !== PlayerStatus.PLAYING) return false;
        return useTimestampStoreBase.getState().timestamp >= AUDIBLE_THRESHOLD_SEC;
    };

    if (signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
    }
    if (isFlowing()) {
        return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
        let done = false;
        const cleanups: Array<() => void> = [];
        const finish = (err?: DOMException) => {
            if (done) return;
            done = true;
            cleanups.forEach((fn) => fn());
            if (err) reject(err);
            else resolve();
        };

        const check = () => {
            if (isFlowing()) finish();
        };

        cleanups.push(usePlayerStoreBase.subscribe(check));
        cleanups.push(useTimestampStoreBase.subscribe(check));

        const cap = setTimeout(() => finish(), maxWaitMs);
        cleanups.push(() => clearTimeout(cap));

        if (signal) {
            const onAbort = () => finish(new DOMException('aborted', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
            cleanups.push(() => signal.removeEventListener('abort', onAbort));
        }
    });
};
