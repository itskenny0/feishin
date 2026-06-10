import { describe, expect, it } from 'vitest';

import {
    WAKE_LOCK_RELEASE_GRACE_MS,
    type WakeLockIntent,
    wakeLockIntentForStatus,
} from './wake-lock-intent';

import { PlayerStatus } from '/@/shared/types/types';

describe('wakeLockIntentForStatus', () => {
    it('acquires the wake lock while playing', () => {
        expect(wakeLockIntentForStatus(PlayerStatus.PLAYING)).toBe('acquire');
    });

    it('schedules a delayed release while paused', () => {
        expect(wakeLockIntentForStatus(PlayerStatus.PAUSED)).toBe('release-grace');
    });

    it('releases immediately for any non-play/pause status', () => {
        // PlayerStatus only models PLAYING/PAUSED today, but the mapping must
        // fail safe (release the CPU lock) for any other/unknown value so a
        // future "stopped"-style status can never strand the lock held.
        const unknown = 'stopped' as unknown as PlayerStatus;
        expect(wakeLockIntentForStatus(unknown)).toBe('release');
    });

    it('only ever returns the three known intents', () => {
        const valid: WakeLockIntent[] = ['acquire', 'release', 'release-grace'];
        for (const status of [PlayerStatus.PLAYING, PlayerStatus.PAUSED]) {
            expect(valid).toContain(wakeLockIntentForStatus(status));
        }
    });

    it('uses a non-zero grace period so a pause→play toggle does not thrash', () => {
        expect(WAKE_LOCK_RELEASE_GRACE_MS).toBeGreaterThan(0);
    });
});
