import { describe, expect, it } from 'vitest';

import { refForRow, rowFieldsForRef } from './types';

describe('row<->ref mapping', () => {
    it('round-trips an idb ref', () => {
        const blob = new Blob(['x']);
        const fields = rowFieldsForRef({ blob, kind: 'idb' });
        expect(fields).toEqual({ Backend: 'idb', Blob: blob });
        expect(refForRow({ Backend: 'idb', Blob: blob })).toEqual({ blob, kind: 'idb' });
    });

    it('round-trips an fs ref', () => {
        const fields = rowFieldsForRef({ kind: 'fs', path: '/sd/a', volumeId: 'V1' });
        expect(fields).toEqual({ Backend: 'capacitor-fs', Path: '/sd/a', VolumeId: 'V1' });
        expect(refForRow({ Backend: 'capacitor-fs', Path: '/sd/a', VolumeId: 'V1' })).toEqual({
            kind: 'fs',
            path: '/sd/a',
            volumeId: 'V1',
        });
    });

    it('legacy rows with only a Blob and no Backend read as idb', () => {
        const blob = new Blob(['x']);
        expect(refForRow({ Blob: blob })).toEqual({ blob, kind: 'idb' });
    });

    it('returns undefined for an empty row', () => {
        expect(refForRow({})).toBeUndefined();
    });
});
