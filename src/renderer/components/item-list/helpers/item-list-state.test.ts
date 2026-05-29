/**
 * Unit coverage for itemListReducer — the pure state machine behind item-list
 * selection, expansion, and drag tracking. Each action's contract is pinned:
 * which sets/maps it touches, the single-expansion semantics of SET/TOGGLE
 * EXPANDED, the additive/toggling semantics of TOGGLE_SELECTED, the no-op when
 * a row has no extractable id, and the version bump that drives subscriptions.
 */
import { describe, expect, it } from 'vitest';

import {
    initialItemListState,
    itemListReducer,
    ItemListState,
    ItemListStateItemWithRequiredProperties,
} from '/@/renderer/components/item-list/helpers/item-list-state';
import { LibraryItem } from '/@/shared/types/domain-types';

const extractRowId = (item: unknown): string | undefined => {
    if (item && typeof item === 'object' && 'id' in item) {
        return (item as { id?: string }).id;
    }
    return undefined;
};

const makeItem = (id: string): ItemListStateItemWithRequiredProperties => ({
    _itemType: LibraryItem.SONG,
    _serverId: 'server-1',
    id,
});

const freshState = (): ItemListState => ({
    dragging: new Set(),
    draggingItems: new Map(),
    expanded: new Set(),
    expandedItems: new Map(),
    selected: new Set(),
    selectedItems: new Map(),
    version: 0,
});

describe('itemListReducer', () => {
    it('SET_SELECTED records every item with an extractable id and bumps version', () => {
        const state = itemListReducer(freshState(), {
            extractRowId,
            payload: [makeItem('a'), makeItem('b')],
            type: 'SET_SELECTED',
        });

        expect([...state.selected]).toEqual(['a', 'b']);
        expect(state.selectedItems.get('a')).toEqual(makeItem('a'));
        expect(state.version).toBe(1);
    });

    it('SET_SELECTED replaces any prior selection rather than merging', () => {
        const first = itemListReducer(freshState(), {
            extractRowId,
            payload: [makeItem('a')],
            type: 'SET_SELECTED',
        });
        const second = itemListReducer(first, {
            extractRowId,
            payload: [makeItem('b')],
            type: 'SET_SELECTED',
        });

        expect([...second.selected]).toEqual(['b']);
    });

    it('TOGGLE_SELECTED adds then removes an item, preserving other selections', () => {
        const base = itemListReducer(freshState(), {
            extractRowId,
            payload: [makeItem('keep')],
            type: 'SET_SELECTED',
        });

        const added = itemListReducer(base, {
            extractRowId,
            payload: makeItem('x'),
            type: 'TOGGLE_SELECTED',
        });
        expect([...added.selected].sort()).toEqual(['keep', 'x']);

        const removed = itemListReducer(added, {
            extractRowId,
            payload: makeItem('x'),
            type: 'TOGGLE_SELECTED',
        });
        expect([...removed.selected]).toEqual(['keep']);
        expect(removed.selectedItems.has('x')).toBe(false);
    });

    it('TOGGLE_SELECTED is a no-op (same reference) when the id cannot be extracted', () => {
        const state = freshState();
        const result = itemListReducer(state, {
            extractRowId,
            payload: {} as ItemListStateItemWithRequiredProperties,
            type: 'TOGGLE_SELECTED',
        });
        expect(result).toBe(state);
    });

    it('SET_EXPANDED keeps only the first item (single-expansion model)', () => {
        const state = itemListReducer(freshState(), {
            extractRowId,
            payload: [makeItem('first'), makeItem('second')],
            type: 'SET_EXPANDED',
        });
        expect([...state.expanded]).toEqual(['first']);
        expect(state.expandedItems.size).toBe(1);
    });

    it('TOGGLE_EXPANDED expands a collapsed row and collapses an expanded row', () => {
        const expanded = itemListReducer(freshState(), {
            extractRowId,
            payload: makeItem('row'),
            type: 'TOGGLE_EXPANDED',
        });
        expect([...expanded.expanded]).toEqual(['row']);

        const collapsed = itemListReducer(expanded, {
            extractRowId,
            payload: makeItem('row'),
            type: 'TOGGLE_EXPANDED',
        });
        expect(collapsed.expanded.size).toBe(0);
        expect(collapsed.expandedItems.size).toBe(0);
    });

    it('TOGGLE_EXPANDED replaces a different expanded row (single-expansion)', () => {
        const first = itemListReducer(freshState(), {
            extractRowId,
            payload: makeItem('first'),
            type: 'TOGGLE_EXPANDED',
        });
        const second = itemListReducer(first, {
            extractRowId,
            payload: makeItem('second'),
            type: 'TOGGLE_EXPANDED',
        });
        expect([...second.expanded]).toEqual(['second']);
    });

    it('SET_DRAGGING tracks all dragged ids', () => {
        const state = itemListReducer(freshState(), {
            extractRowId,
            payload: [makeItem('a'), makeItem('b')],
            type: 'SET_DRAGGING',
        });
        expect([...state.dragging].sort()).toEqual(['a', 'b']);
        expect(state.draggingItems.size).toBe(2);
    });

    it('CLEAR_SELECTED empties only the selection slices', () => {
        const populated: ItemListState = {
            ...freshState(),
            dragging: new Set(['d']),
            draggingItems: new Map([['d', makeItem('d')]]),
            selected: new Set(['s']),
            selectedItems: new Map([['s', makeItem('s')]]),
            version: 5,
        };
        const cleared = itemListReducer(populated, { type: 'CLEAR_SELECTED' });

        expect(cleared.selected.size).toBe(0);
        expect(cleared.selectedItems.size).toBe(0);
        // Dragging untouched.
        expect([...cleared.dragging]).toEqual(['d']);
        expect(cleared.version).toBe(6);
    });

    it('CLEAR_ALL empties every slice and bumps version', () => {
        const populated: ItemListState = {
            ...freshState(),
            dragging: new Set(['d']),
            expanded: new Set(['e']),
            selected: new Set(['s']),
            version: 9,
        };
        const cleared = itemListReducer(populated, { type: 'CLEAR_ALL' });

        expect(cleared.dragging.size).toBe(0);
        expect(cleared.expanded.size).toBe(0);
        expect(cleared.selected.size).toBe(0);
        expect(cleared.version).toBe(10);
    });

    it('returns the same state reference for an unknown action', () => {
        const state = freshState();
        const result = itemListReducer(state, {
            type: 'NOT_A_REAL_ACTION',
        } as unknown as Parameters<typeof itemListReducer>[1]);
        expect(result).toBe(state);
    });

    it('exposes a zeroed initial state', () => {
        expect(initialItemListState.version).toBe(0);
        expect(initialItemListState.selected.size).toBe(0);
        expect(initialItemListState.expanded.size).toBe(0);
        expect(initialItemListState.dragging.size).toBe(0);
    });
});
