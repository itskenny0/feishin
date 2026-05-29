/**
 * Unit coverage for createExtractRowId — the row-identity resolver used by
 * every item-list grid/table to map an arbitrary data item back to its stable
 * key. Selection, expansion, and drag state all hinge on this returning the
 * same id for the same logical row, so the three input shapes (default 'id',
 * a property-name string, and a custom function) each get exercised.
 */
import { describe, expect, it } from 'vitest';

import { createExtractRowId } from '/@/renderer/components/item-list/helpers/extract-row-id';

describe('createExtractRowId', () => {
    it('reads the default "id" property when no getRowId is supplied', () => {
        const extract = createExtractRowId();
        expect(extract({ id: 'abc' })).toBe('abc');
    });

    it('reads a custom property name when getRowId is a string', () => {
        const extract = createExtractRowId('uuid');
        expect(extract({ id: 'abc', uuid: 'xyz' })).toBe('xyz');
    });

    it('delegates to the function when getRowId is a function', () => {
        const extract = createExtractRowId((item) => `${(item as { n: number }).n}-key`);
        expect(extract({ n: 7 })).toBe('7-key');
    });

    it('returns undefined for null, undefined, and primitive inputs', () => {
        const extract = createExtractRowId();
        expect(extract(null)).toBeUndefined();
        expect(extract(undefined)).toBeUndefined();
        expect(extract('string')).toBeUndefined();
        expect(extract(42)).toBeUndefined();
    });

    it('returns undefined when the default id property is absent', () => {
        const extract = createExtractRowId();
        expect(extract({ name: 'no id here' })).toBeUndefined();
    });

    it('returns undefined when the named property is absent', () => {
        const extract = createExtractRowId('missing');
        expect(extract({ id: 'present' })).toBeUndefined();
    });

    it('does not call a function-style getRowId for non-object inputs', () => {
        let called = false;
        const extract = createExtractRowId(() => {
            called = true;
            return 'should-not-be-returned';
        });
        expect(extract(null)).toBeUndefined();
        expect(called).toBe(false);
    });
});
