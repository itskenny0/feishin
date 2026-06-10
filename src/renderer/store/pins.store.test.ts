// Pin-to-homepage store: add/remove/toggle semantics, per-server scoping,
// and duplicate protection.

import { beforeEach, describe, expect, it } from 'vitest';

import { type PinItemType, usePinsStore } from '/@/renderer/store/pins.store';
import { LibraryItem } from '/@/shared/types/domain-types';

const actions = () => usePinsStore.getState().actions;

const pin = (id: string, serverId = 'srv1', itemType: PinItemType = LibraryItem.ALBUM) => ({
    id,
    imageId: null,
    itemType,
    name: `name-${id}`,
    serverId,
});

beforeEach(() => {
    usePinsStore.setState({ pins: [] });
});

describe('pins.store', () => {
    it('addPin appends with a pinnedAt stamp; duplicates are ignored', () => {
        actions().addPin(pin('a'));
        actions().addPin(pin('a'));
        const pins = usePinsStore.getState().pins;
        expect(pins).toHaveLength(1);
        expect(pins[0].pinnedAt).toBeGreaterThan(0);
    });

    it('the same id under a different itemType or server is a distinct pin', () => {
        actions().addPin(pin('a'));
        actions().addPin(pin('a', 'srv1', LibraryItem.PLAYLIST));
        actions().addPin(pin('a', 'srv2'));
        expect(usePinsStore.getState().pins).toHaveLength(3);
    });

    it('removePin removes exactly the matching (server, type, id) triple', () => {
        actions().addPin(pin('a'));
        actions().addPin(pin('b'));
        actions().addPin(pin('a', 'srv2'));
        actions().removePin('srv1', LibraryItem.ALBUM, 'a');
        const pins = usePinsStore.getState().pins;
        expect(pins.map((p) => `${p.serverId}:${p.id}`)).toEqual(['srv1:b', 'srv2:a']);
    });

    it('togglePin flips between pinned and unpinned', () => {
        actions().togglePin(pin('a'));
        expect(usePinsStore.getState().pins).toHaveLength(1);
        actions().togglePin(pin('a'));
        expect(usePinsStore.getState().pins).toHaveLength(0);
    });

    it('clearPins scopes to a server when given one, else wipes everything', () => {
        actions().addPin(pin('a'));
        actions().addPin(pin('b', 'srv2'));
        actions().clearPins('srv1');
        expect(usePinsStore.getState().pins.map((p) => p.serverId)).toEqual(['srv2']);
        actions().clearPins();
        expect(usePinsStore.getState().pins).toHaveLength(0);
    });
});
