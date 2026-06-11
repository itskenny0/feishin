import { describe, expect, it } from 'vitest';

import {
    DEFAULT_HOME_ITEM_ORDER,
    DEFAULT_HOME_ITEMS_ENABLED,
    HomeItem,
    resolveHomeSections,
} from '/@/renderer/store/settings.store';

const ids = (items: Array<{ disabled: boolean; id: string }>) => items.map((i) => i.id);

describe('resolveHomeSections', () => {
    it('returns every live section in canonical order with default flags for empty input', () => {
        for (const input of [undefined, null, []] as const) {
            const resolved = resolveHomeSections(input);
            expect(ids(resolved)).toEqual(DEFAULT_HOME_ITEM_ORDER);
            // Lean default: pinned / quick picks / recently played /
            // most played / playlists on, discovery shelves opt-in.
            expect(resolved.map((i) => [i.id, i.disabled])).toEqual(
                DEFAULT_HOME_ITEM_ORDER.map((id) => [id, !DEFAULT_HOME_ITEMS_ENABLED.has(id)]),
            );
        }
    });

    it('drops legacy ids from the previous home layout', () => {
        const persisted = [
            { disabled: false, id: 'newSinceLastVisit' },
            { disabled: false, id: 'quickFilters' },
            { disabled: true, id: 'libraryStats' },
            { disabled: false, id: HomeItem.RECENTLY_PLAYED },
        ];

        const resolved = resolveHomeSections(persisted);

        expect(ids(resolved)).not.toContain('newSinceLastVisit');
        expect(ids(resolved)).not.toContain('quickFilters');
        expect(ids(resolved)).not.toContain('libraryStats');
        // The one live id stays at the front; missing live sections append after.
        expect(resolved[0]).toEqual({ disabled: false, id: HomeItem.RECENTLY_PLAYED });
    });

    it('drops unknown/garbage ids and tolerates malformed entries', () => {
        const persisted = [
            { disabled: false, id: 'totallyMadeUp' },

            null as any,

            { disabled: false } as any,
            { disabled: false, id: HomeItem.GENRES },
        ];

        const resolved = resolveHomeSections(persisted);

        expect(ids(resolved)).not.toContain('totallyMadeUp');
        expect(ids(resolved)).not.toContain(undefined);
        expect(ids(resolved)).toContain(HomeItem.GENRES);
        // Every resolved id is a live section.
        expect(ids(resolved).every((id) => DEFAULT_HOME_ITEM_ORDER.includes(id as HomeItem))).toBe(
            true,
        );
    });

    it('preserves the user-saved order and enabled/disabled flags', () => {
        const persisted = [
            { disabled: false, id: HomeItem.GENRES },
            { disabled: true, id: HomeItem.PINNED },
            { disabled: false, id: HomeItem.RANDOM },
        ];

        const resolved = resolveHomeSections(persisted);

        // The three saved sections keep their order at the front...
        expect(ids(resolved).slice(0, 3)).toEqual([
            HomeItem.GENRES,
            HomeItem.PINNED,
            HomeItem.RANDOM,
        ]);
        expect(resolved.find((i) => i.id === HomeItem.PINNED)?.disabled).toBe(true);
        expect(resolved.find((i) => i.id === HomeItem.RANDOM)?.disabled).toBe(false);
    });

    it('appends newly-shipped live sections (with their default flags) in canonical slots', () => {
        // Simulate a config saved before quickPicks/artists/playlists existed.
        const persisted = [
            { disabled: false, id: HomeItem.RECENTLY_PLAYED },
            { disabled: true, id: HomeItem.MOST_PLAYED },
        ];

        const resolved = resolveHomeSections(persisted);
        const map = new Map(resolved.map((i) => [i.id, i.disabled]));

        // Saved entries keep their flags.
        expect(map.get(HomeItem.RECENTLY_PLAYED)).toBe(false);
        expect(map.get(HomeItem.MOST_PLAYED)).toBe(true);

        // Every live section is present...
        for (const id of DEFAULT_HOME_ITEM_ORDER) {
            expect(map.has(id)).toBe(true);
        }
        // ...and the ones not in the saved config follow the DEFAULT flags:
        // quick picks / playlists ship enabled, artists ships disabled.
        expect(map.get(HomeItem.QUICK_PICKS)).toBe(false);
        expect(map.get(HomeItem.ARTISTS)).toBe(true);
        expect(map.get(HomeItem.PLAYLISTS)).toBe(false);
    });

    it('de-duplicates repeated ids, keeping the first occurrence', () => {
        const persisted = [
            { disabled: true, id: HomeItem.PINNED },
            { disabled: false, id: HomeItem.PINNED },
        ];

        const resolved = resolveHomeSections(persisted);
        const pinnedEntries = resolved.filter((i) => i.id === HomeItem.PINNED);

        expect(pinnedEntries).toHaveLength(1);
        expect(pinnedEntries[0].disabled).toBe(true);
    });

    it('never emits legacy enum members in the default order', () => {
        expect(DEFAULT_HOME_ITEM_ORDER).not.toContain(HomeItem.LIBRARY_STATS);
        expect(DEFAULT_HOME_ITEM_ORDER).not.toContain(HomeItem.NEW_SINCE_LAST_VISIT);
        expect(DEFAULT_HOME_ITEM_ORDER).not.toContain(HomeItem.QUICK_FILTERS);
    });
});
