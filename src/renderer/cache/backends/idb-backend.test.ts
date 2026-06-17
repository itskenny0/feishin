import { describe, expect, it } from 'vitest';

import { idbBackend } from './idb-backend';

describe('IndexedDbBackend', () => {
    it('store wraps the blob inline as an idb ref', async () => {
        const blob = new Blob(['hi']);
        const ref = await idbBackend.store('audio', 'k', blob);
        expect(ref).toEqual({ blob, kind: 'idb' });
    });

    it('load returns the inline blob', async () => {
        const blob = new Blob(['hi']);
        const out = await idbBackend.load({ blob, kind: 'idb' });
        expect(out).toBe(blob);
    });

    it('load of an fs ref returns undefined (wrong backend)', async () => {
        expect(await idbBackend.load({ kind: 'fs', path: '/x', volumeId: 'V' })).toBeUndefined();
    });

    it('remove is a no-op and health is always available', async () => {
        await expect(idbBackend.remove({ blob: new Blob(), kind: 'idb' })).resolves.toBeUndefined();
        expect(await idbBackend.health()).toEqual({ available: true });
    });
});
