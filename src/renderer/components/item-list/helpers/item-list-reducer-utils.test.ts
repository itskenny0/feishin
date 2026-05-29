/**
 * Unit coverage for the item-list reducer companion utilities: action
 * creators (shape contracts), selectors (state -> derived values), and the
 * toggle-all helpers that flip between select-all and clear based on the
 * current selection/expansion of a row set.
 */
import { describe, expect, it } from 'vitest';

import {
    itemListActions,
    itemListSelectors,
    itemListUtils,
} from '/@/renderer/components/item-list/helpers/item-list-reducer-utils';
import {
    ItemListState,
    ItemListStateItemWithRequiredProperties,
} from '/@/renderer/components/item-list/helpers/item-list-state';
import { LibraryItem } from '/@/shared/types/domain-types';

const extractRowId = (item: unknown): string | undefined =>
    item && typeof item === 'object' && 'id' in item ? (item as { id?: string }).id : undefined;

const makeItem = (id: string): ItemListStateItemWithRequiredProperties => ({
    _itemType: LibraryItem.SONG,
    _serverId: 'server-1',
    id,
});

const stateWith = (overrides: Partial<ItemListState> = {}): ItemListState => ({
    dragging: new Set(),
    draggingItems: new Map(),
    expanded: new Set(),
    expandedItems: new Map(),
    selected: new Set(),
    selectedItems: new Map(),
    version: 0,
    ...overrides,
});

describe('itemListActions', () => {
    it('creates clear actions with the right discriminant', () => {
        expect(itemListActions.clearAll()).toEqual({ type: 'CLEAR_ALL' });
        expect(itemListActions.clearExpanded()).toEqual({ type: 'CLEAR_EXPANDED' });
        expect(itemListActions.clearSelected()).toEqual({ type: 'CLEAR_SELECTED' });
    });

    it('threads payload and extractRowId through the setter/toggle creators', () => {
        const items = [makeItem('a')];
        expect(itemListActions.setSelected(items, extractRowId)).toEqual({
            extractRowId,
            payload: items,
            type: 'SET_SELECTED',
        });
        expect(itemListActions.toggleSelected(items[0], extractRowId)).toEqual({
            extractRowId,
            payload: items[0],
            type: 'TOGGLE_SELECTED',
        });
    });
});

describe('itemListSelectors', () => {
    const state = stateWith({
        selected: new Set(['a', 'b']),
        selectedItems: new Map([
            ['a', makeItem('a')],
            ['b', makeItem('b')],
        ]),
        version: 3,
    });

    it('derives ids, counts, and item arrays from the selection slice', () => {
        expect(itemListSelectors.getSelectedIds(state).sort()).toEqual(['a', 'b']);
        expect(itemListSelectors.getSelectedCount(state)).toBe(2);
        expect(itemListSelectors.getSelected(state)).toHaveLength(2);
    });

    it('reports membership and presence', () => {
        expect(itemListSelectors.isSelected(state, 'a')).toBe(true);
        expect(itemListSelectors.isSelected(state, 'missing')).toBe(false);
        expect(itemListSelectors.hasAnySelected(state)).toBe(true);
        expect(itemListSelectors.hasAnySelected(stateWith())).toBe(false);
    });

    it('reads the version', () => {
        expect(itemListSelectors.getVersion(state)).toBe(3);
    });
});

describe('itemListUtils', () => {
    it('areAllSelected requires every id to be present', () => {
        const state = stateWith({ selected: new Set(['a', 'b']) });
        expect(itemListUtils.areAllSelected(state, ['a', 'b'])).toBe(true);
        expect(itemListUtils.areAllSelected(state, ['a', 'c'])).toBe(false);
    });

    it('areAnySelected requires at least one id to be present', () => {
        const state = stateWith({ selected: new Set(['a']) });
        expect(itemListUtils.areAnySelected(state, ['a', 'c'])).toBe(true);
        expect(itemListUtils.areAnySelected(state, ['x', 'y'])).toBe(false);
    });

    it('isMultiSelect / isMultiExpand reflect a size > 1', () => {
        expect(itemListUtils.isMultiSelect(stateWith({ selected: new Set(['a', 'b']) }))).toBe(
            true,
        );
        expect(itemListUtils.isMultiSelect(stateWith({ selected: new Set(['a']) }))).toBe(false);
        expect(itemListUtils.isMultiExpand(stateWith({ expanded: new Set(['a', 'b']) }))).toBe(
            true,
        );
        expect(itemListUtils.isMultiExpand(stateWith({ expanded: new Set(['a']) }))).toBe(false);
    });

    it('toggleAllSelected selects when not all are selected, clears when all are', () => {
        const items = [makeItem('a'), makeItem('b')];

        const noneSelected = stateWith();
        expect(itemListUtils.toggleAllSelected(items, noneSelected, extractRowId).type).toBe(
            'SET_SELECTED',
        );

        const allSelected = stateWith({ selected: new Set(['a', 'b']) });
        expect(itemListUtils.toggleAllSelected(items, allSelected, extractRowId).type).toBe(
            'CLEAR_SELECTED',
        );
    });

    it('toggleAllExpanded selects when not all are expanded, clears when all are', () => {
        const items = [makeItem('a'), makeItem('b')];

        const noneExpanded = stateWith();
        expect(itemListUtils.toggleAllExpanded(items, noneExpanded, extractRowId).type).toBe(
            'SET_EXPANDED',
        );

        const allExpanded = stateWith({ expanded: new Set(['a', 'b']) });
        expect(itemListUtils.toggleAllExpanded(items, allExpanded, extractRowId).type).toBe(
            'CLEAR_EXPANDED',
        );
    });
});
