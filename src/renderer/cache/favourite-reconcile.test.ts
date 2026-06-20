// Contract tests for `computeStaleFavoriteKeys` — the favourites-sweep
// reconciliation pass that prunes rows whose server-side favourite state has
// flipped to false since the last sweep.
//
// The bug this pins: reconciliation built one global `freshKeys` set across the
// albums + artists + songs sub-fetches and deleted ANY `IsFavorite` row not in
// it. If a sub-fetch returned 0 items for a transient reason (server hiccup, an
// aborted page), that entity contributed no fresh keys, so EVERY existing
// favourite of that type was pruned — silently wiping the user's favourite
// albums. Reconciliation must only prune an ItemType whose sub-fetch was
// actually observed (returned ≥1 item) this run; an empty fetch is treated as
// "not authoritative" and leaves that type's favourites untouched.

import { describe, expect, it } from 'vitest';

import { computeStaleFavoriteKeys, favoriteKey } from '/@/renderer/cache/sync/favorites';

const row = (ItemId: string, ItemType: string, IsFavorite = true) => ({
    IsFavorite,
    ItemId,
    ItemType,
});

describe('computeStaleFavoriteKeys', () => {
    it('prunes a genuinely-stale row when its type WAS fetched non-empty', () => {
        const rows = [row('a1', 'Album'), row('a2', 'Album')];
        const freshKeys = new Set(['a1 Album']); // a2 is no longer a favourite
        const fetchedTypes = new Set(['Album']);

        expect(computeStaleFavoriteKeys(rows, freshKeys, fetchedTypes)).toEqual([['a2', 'Album']]);
    });

    it('does NOT prune ANY album favourite when the albums fetch came back empty', () => {
        const rows = [row('a1', 'Album'), row('a2', 'Album')];
        const freshKeys = new Set<string>(); // albums sub-fetch returned 0
        const fetchedTypes = new Set<string>(); // → Album not authoritatively observed

        expect(computeStaleFavoriteKeys(rows, freshKeys, fetchedTypes)).toEqual([]);
    });

    it('never prunes IsFavorite:false rows (rating / play-count baselines)', () => {
        const rows = [row('s1', 'Song', false), row('s2', 'Song', false)];
        const freshKeys = new Set<string>();
        const fetchedTypes = new Set(['Song']);

        expect(computeStaleFavoriteKeys(rows, freshKeys, fetchedTypes)).toEqual([]);
    });

    it('regression: a row keyed via favoriteKey is NEVER pruned (no separator divergence)', () => {
        // The original bug: the fresh set was built with a NUL separator while
        // the membership check used a space, so a just-written favourite never
        // matched and was deleted. Building freshKeys through the SAME
        // favoriteKey() the sweep uses must keep the row.
        const rows = [row('a1', 'Album')];
        const freshKeys = new Set([favoriteKey('a1', 'Album')]);
        const fetchedTypes = new Set(['Album']);

        expect(computeStaleFavoriteKeys(rows, freshKeys, fetchedTypes)).toEqual([]);
    });

    it('reconciles each type independently — empty albums fetch does not block song pruning', () => {
        const rows = [row('a1', 'Album'), row('s1', 'Song'), row('s2', 'Song')];
        const freshKeys = new Set(['s1 Song']); // songs fetched: s1 kept, s2 stale
        const fetchedTypes = new Set(['Song']); // albums NOT fetched this run

        expect(computeStaleFavoriteKeys(rows, freshKeys, fetchedTypes)).toEqual([['s2', 'Song']]);
    });
});
