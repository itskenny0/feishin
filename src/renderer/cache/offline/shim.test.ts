import { describe, expect, it } from 'vitest';

import * as shim from '../offline-media';

describe('offline-media back-compat shim', () => {
    it('still exports the names its importers use', () => {
        for (const name of [
            'cancelOfflineSync',
            'refreshOfflineAvailability',
            'refreshOfflineStats',
        ]) {
            expect(typeof (shim as Record<string, unknown>)[name]).toBe('function');
        }
    });
});
