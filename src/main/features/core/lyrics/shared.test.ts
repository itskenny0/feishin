// @vitest-environment node
/**
 * Unit tests for the lyric search ranking helper. `orderSearchResults` is a
 * pure function: given a set of provider search responses plus the original
 * query, it returns the same responses re-ranked (best match first) with a
 * fuse.js `score` attached. No network, no Electron — just fuse.js + data.
 */
import { describe, expect, it } from 'vitest';

import { orderSearchResults } from './shared';

import {
    InternetProviderLyricSearchResponse,
    LyricSearchQuery,
    LyricSource,
} from '/@/shared/types/domain-types';

const makeResult = (
    overrides: Partial<InternetProviderLyricSearchResponse> &
        Pick<InternetProviderLyricSearchResponse, 'artist' | 'id' | 'name'>,
): InternetProviderLyricSearchResponse => ({
    isSync: null,
    source: LyricSource.LRCLIB,
    ...overrides,
});

describe('orderSearchResults', () => {
    it('returns matching items with a score attached', () => {
        const results = [
            makeResult({ artist: 'Daft Punk', id: '1', name: 'Get Lucky' }),
            makeResult({ artist: 'Daft Punk', id: '2', name: 'Get Lucky (Radio Edit)' }),
        ];
        const params: LyricSearchQuery = { artist: 'Daft Punk', name: 'Get Lucky' };

        const ranked = orderSearchResults({ params, results });

        expect(ranked.length).toBeGreaterThan(0);
        ranked.forEach((item) => {
            expect(item).toHaveProperty('score');
            expect(item).toHaveProperty('id');
            expect(item).toHaveProperty('artist');
            expect(item).toHaveProperty('name');
        });
    });

    it('ranks the exact artist+name match ahead of an unrelated entry', () => {
        const results = [
            makeResult({ artist: 'Unrelated Band', id: 'noise', name: 'Completely Different' }),
            makeResult({ artist: 'Daft Punk', id: 'match', name: 'Get Lucky' }),
        ];
        const params: LyricSearchQuery = { artist: 'Daft Punk', name: 'Get Lucky' };

        const ranked = orderSearchResults({ params, results });

        expect(ranked[0].id).toBe('match');
    });

    it('orders synced lyrics ahead of plain lyrics for equivalent matches', () => {
        const results = [
            makeResult({ artist: 'Daft Punk', id: 'plain', isSync: false, name: 'Get Lucky' }),
            makeResult({ artist: 'Daft Punk', id: 'synced', isSync: true, name: 'Get Lucky' }),
        ];
        const params: LyricSearchQuery = { artist: 'Daft Punk', name: 'Get Lucky' };

        const ranked = orderSearchResults({ params, results });

        const syncedIndex = ranked.findIndex((r) => r.id === 'synced');
        const plainIndex = ranked.findIndex((r) => r.id === 'plain');

        expect(syncedIndex).toBeGreaterThanOrEqual(0);
        expect(plainIndex).toBeGreaterThanOrEqual(0);
        expect(syncedIndex).toBeLessThan(plainIndex);
    });

    it('falls back to a single-field fuzzy search when only a name is provided', () => {
        const results = [
            makeResult({ artist: 'Daft Punk', id: 'match', name: 'Get Lucky' }),
            makeResult({ artist: 'Someone Else', id: 'other', name: 'Totally Unrelated' }),
        ];
        const params: LyricSearchQuery = { name: 'Get Lucky' };

        const ranked = orderSearchResults({ params, results });

        expect(ranked.length).toBeGreaterThan(0);
        expect(ranked[0].id).toBe('match');
    });

    it('returns an empty array when no item matches the query', () => {
        const results = [
            makeResult({ artist: 'Someone', id: 'a', name: 'Foo' }),
            makeResult({ artist: 'Another', id: 'b', name: 'Bar' }),
        ];
        const params: LyricSearchQuery = { name: 'zzzzz-no-such-title-zzzzz' };

        const ranked = orderSearchResults({ params, results });

        expect(ranked).toEqual([]);
    });

    it('preserves the original item fields on the ranked output', () => {
        const results = [
            makeResult({
                artist: 'Daft Punk',
                id: 'keep',
                isSync: true,
                name: 'Get Lucky',
                source: LyricSource.GENIUS,
            }),
        ];
        const params: LyricSearchQuery = { artist: 'Daft Punk', name: 'Get Lucky' };

        const ranked = orderSearchResults({ params, results });

        expect(ranked[0]).toMatchObject({
            artist: 'Daft Punk',
            id: 'keep',
            isSync: true,
            name: 'Get Lucky',
            source: LyricSource.GENIUS,
        });
    });
});
