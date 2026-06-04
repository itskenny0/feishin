/**
 * Regression coverage for range-selection item validation.
 *
 * Bug (grid shift+arrow): the grid's range handler gated candidate rows on
 * `'itemType' in item`, but normalized library items expose `_itemType`
 * (underscore-prefixed) — there is no plain `itemType` property. The predicate
 * therefore rejected every real item, so shift+arrow never filled the range
 * between the anchor and the target (it only ever added the single new cell).
 * The shift+click path in `item-list-controls.ts` already used `_itemType`,
 * so the two selection paths disagreed.
 */
import { describe, expect, it } from 'vitest';

import { isRangeSelectableItem } from '/@/renderer/components/item-list/helpers/is-range-selectable-item';
import { LibraryItem } from '/@/shared/types/domain-types';

const realItem = {
    _itemType: LibraryItem.ALBUM,
    _serverId: 'server-1',
    id: 'album-1',
    name: 'Some Album',
};

describe('isRangeSelectableItem', () => {
    it('accepts a normalized library item (uses _itemType, not itemType)', () => {
        expect(isRangeSelectableItem(realItem)).toBe(true);
    });

    it('rejects an item that only carries the (wrong) plain itemType key', () => {
        // This is exactly the shape the old `'itemType' in item` check would
        // have required — proving normalized items never matched it.
        const wrongShape = {
            _serverId: 'server-1',
            id: 'album-1',
            itemType: LibraryItem.ALBUM,
        };
        expect(isRangeSelectableItem(wrongShape)).toBe(false);
    });

    it('rejects group-header / placeholder / header rows', () => {
        expect(isRangeSelectableItem(null)).toBe(false);
        expect(isRangeSelectableItem(undefined)).toBe(false);
        expect(isRangeSelectableItem({})).toBe(false);
        // Missing _serverId
        expect(isRangeSelectableItem({ _itemType: LibraryItem.SONG, id: 'x' })).toBe(false);
        // Missing id
        expect(isRangeSelectableItem({ _itemType: LibraryItem.SONG, _serverId: 's' })).toBe(false);
    });

    it('narrows the type for downstream consumers', () => {
        const candidate: unknown = realItem;
        if (isRangeSelectableItem(candidate)) {
            // Type narrowing: these property accesses must compile.
            expect(candidate._serverId).toBe('server-1');
            expect(candidate.id).toBe('album-1');
        }
    });
});
