/**
 * Unit coverage for getDraggedItems — decides which items a drag operation
 * carries. If the grabbed row is part of the current selection, drag the whole
 * selection; otherwise drag (and, by default, select) just the grabbed row.
 * Items lacking the required drag identity (id / _itemType / _serverId) are
 * rejected — this is the surface whose type guard was tightened, so the
 * behaviour is pinned here.
 */
import { describe, expect, it, vi } from 'vitest';

import { getDraggedItems } from '/@/renderer/components/item-list/helpers/get-dragged-items';
import {
    ItemListStateActions,
    ItemListStateItemWithRequiredProperties,
} from '/@/renderer/components/item-list/helpers/item-list-state';
import { LibraryItem, Song } from '/@/shared/types/domain-types';

const song = (id: string): Song =>
    ({
        _itemType: LibraryItem.SONG,
        _serverId: 'server-1',
        id,
    }) as unknown as Song;

const mockState = (
    selected: ItemListStateItemWithRequiredProperties[],
): ItemListStateActions & { setSelected: ReturnType<typeof vi.fn> } => {
    const extractRowId = (item: unknown): string | undefined =>
        item && typeof item === 'object' && 'id' in item ? (item as { id?: string }).id : undefined;

    return {
        extractRowId,
        getSelected: () => selected,
        setSelected: vi.fn(),
    } as unknown as ItemListStateActions & { setSelected: ReturnType<typeof vi.fn> };
};

describe('getDraggedItems', () => {
    it('returns an empty array for undefined data', () => {
        expect(getDraggedItems(undefined)).toEqual([]);
    });

    it('returns an empty array when the item lacks required drag identity fields', () => {
        const incomplete = { id: 'x' } as unknown as Song;
        expect(getDraggedItems(incomplete)).toEqual([]);
    });

    it('rejects an item whose identity fields are the wrong type', () => {
        const wrongTypes = {
            _itemType: 123,
            _serverId: true,
            id: 'x',
        } as unknown as Song;
        expect(getDraggedItems(wrongTypes)).toEqual([]);
    });

    it('returns the single item when no internal state is provided', () => {
        const item = song('a');
        expect(getDraggedItems(item)).toEqual([item]);
    });

    it('drags the whole selection when the grabbed row is already selected', () => {
        const a = song('a');
        const b = song('b');
        const state = mockState([
            a as unknown as ItemListStateItemWithRequiredProperties,
            b as unknown as ItemListStateItemWithRequiredProperties,
        ]);

        const result = getDraggedItems(a, state);
        expect(result.map((i) => i.id).sort()).toEqual(['a', 'b']);
        // Selection unchanged when dragging an already-selected row.
        expect(state.setSelected).not.toHaveBeenCalled();
    });

    it('drags and selects only the grabbed row when it is not selected', () => {
        const a = song('a');
        const state = mockState([]);

        const result = getDraggedItems(a, state);
        expect(result.map((i) => i.id)).toEqual(['a']);
        expect(state.setSelected).toHaveBeenCalledTimes(1);
    });

    it('does not mutate the selection when updateSelection is false', () => {
        const a = song('a');
        const state = mockState([]);

        const result = getDraggedItems(a, state, false);
        expect(result.map((i) => i.id)).toEqual(['a']);
        expect(state.setSelected).not.toHaveBeenCalled();
    });
});
