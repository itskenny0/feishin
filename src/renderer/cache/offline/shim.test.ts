import { describe, expect, it } from 'vitest';

import * as shim from '../offline-media';

describe('offline-media back-compat shim', () => {
    it('still exports the historical names', () => {
        for (const name of [
            'addAndSyncOfflineTarget',
            'addOfflineTarget',
            'cancelOfflineSync',
            'enumerateTargetSongs',
            'isSyncing',
            'refreshOfflineAvailability',
            'refreshOfflineStats',
            'removeAllTargets',
            'removeOfflineTarget',
            'syncAllTargets',
            'syncTarget',
        ]) {
            expect(typeof (shim as Record<string, unknown>)[name]).toBe('function');
        }
    });
});
