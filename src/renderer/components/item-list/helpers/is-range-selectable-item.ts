import { ItemListStateItemWithRequiredProperties } from '/@/renderer/components/item-list/helpers/item-list-state';

/**
 * Predicate used by range-selection (shift+click / shift+arrow) to decide
 * whether a candidate row is a real, selectable item rather than a group
 * header / placeholder / header row.
 *
 * Normalized library items expose `_itemType` (underscore-prefixed) — NOT
 * `itemType`. A historical typo (`'itemType' in item`) in the grid's
 * shift+arrow handler caused this predicate to reject every real item, so the
 * range between the anchor and the target was never filled in. Keep the
 * property name in sync with the domain types in `domain-types.ts`.
 */
export const isRangeSelectableItem = (
    item: unknown,
): item is ItemListStateItemWithRequiredProperties => {
    return (
        !!item &&
        typeof item === 'object' &&
        '_serverId' in item &&
        '_itemType' in item &&
        'id' in item
    );
};
