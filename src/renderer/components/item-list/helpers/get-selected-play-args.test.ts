/**
 * Regression coverage for the list play-HOTKEYS playing the FULL selection.
 *
 * Bug: the four list play-hotkeys (default/now/next/last) passed
 * `validSelected[0]` to `controls.onPlay`, which plays exactly one item
 * (`addToQueueByFetch(serverId, [id], ...)`). With multiple rows selected every
 * row but the first was silently dropped — disagreeing with the context-menu
 * play path (`items.map(i => i.id)`).
 *
 * Fix: a selection-aware `onPlaySelected` control gathers ALL selected ids via
 * this pure helper and issues one `addToQueueByFetch` per server with the whole
 * id array. The per-row hover "play" button keeps using `onPlay` (single item).
 */
import { describe, expect, it } from 'vitest';

import { getSelectedPlayArgs } from '/@/renderer/components/item-list/helpers/get-selected-play-args';
import { ItemListStateItemWithRequiredProperties } from '/@/renderer/components/item-list/helpers/item-list-state';
import { LibraryItem } from '/@/shared/types/domain-types';

const item = (id: string, serverId = 'server-1'): ItemListStateItemWithRequiredProperties => ({
    _itemType: LibraryItem.SONG,
    _serverId: serverId,
    id,
});

describe('getSelectedPlayArgs', () => {
    it('returns every selected id (not just the first)', () => {
        const groups = getSelectedPlayArgs([item('a'), item('b'), item('c')]);
        expect(groups).toEqual([{ ids: ['a', 'b', 'c'], serverId: 'server-1' }]);
    });

    it('preserves selection/display order', () => {
        const groups = getSelectedPlayArgs([item('c'), item('a'), item('b')]);
        expect(groups[0].ids).toEqual(['c', 'a', 'b']);
    });

    it('returns the single id for a single selection (parity with the row button)', () => {
        const groups = getSelectedPlayArgs([item('only')]);
        expect(groups).toEqual([{ ids: ['only'], serverId: 'server-1' }]);
    });

    it('returns no groups for an empty selection (caller guards the empty case)', () => {
        expect(getSelectedPlayArgs([])).toEqual([]);
    });

    it('de-duplicates repeated ids within a server, keeping first-seen order', () => {
        const groups = getSelectedPlayArgs([item('a'), item('b'), item('a')]);
        expect(groups[0].ids).toEqual(['a', 'b']);
    });

    it('groups by server so a cross-server selection issues one fetch per server', () => {
        const groups = getSelectedPlayArgs([
            item('a', 'server-1'),
            item('b', 'server-2'),
            item('c', 'server-1'),
        ]);
        expect(groups).toEqual([
            { ids: ['a', 'c'], serverId: 'server-1' },
            { ids: ['b'], serverId: 'server-2' },
        ]);
    });

    it('skips items missing id or serverId', () => {
        const malformed = [
            item('a'),
            { _itemType: LibraryItem.SONG, _serverId: 'server-1', id: '' },
            { _itemType: LibraryItem.SONG, _serverId: '', id: 'b' },
        ] as ItemListStateItemWithRequiredProperties[];
        const groups = getSelectedPlayArgs(malformed);
        expect(groups).toEqual([{ ids: ['a'], serverId: 'server-1' }]);
    });
});
