// Unit tests for the pure player-filter logic in utils.ts.
//
// filterSongsByPlayerFilters EXCLUDES songs that match any enabled filter
// (it is a deny-list applied before enqueue). These tests pin the per-operator
// matching semantics, the field resolution, and the "no valid filters → pass
// everything through" short-circuit.

import { describe, expect, it } from 'vitest';

import { filterSongsByPlayerFilters } from '/@/renderer/features/player/utils';
import { PlayerFilter } from '/@/renderer/store';
import { Song } from '/@/shared/types/domain-types';

// Minimal Song-shaped fixture; only the fields read by getSongFieldValue are
// populated. Everything else is left undefined and never touched by the filter.
const song = (overrides: Partial<Record<keyof Song, unknown>>): Song =>
    ({
        albumArtists: [],
        artists: [],
        comment: null,
        duration: null,
        genres: [],
        id: 'song-id',
        name: '',
        path: null,
        playCount: null,
        releaseYear: null,
        userFavorite: false,
        userRating: null,
        ...overrides,
    }) as Song;

const filter = (overrides: Partial<PlayerFilter>): PlayerFilter =>
    ({
        field: 'name',
        id: 'filter-id',
        isEnabled: true,
        operator: 'is',
        value: '',
        ...overrides,
    }) as PlayerFilter;

describe('filterSongsByPlayerFilters', () => {
    it('returns all songs when there are no filters', () => {
        const songs = [song({ name: 'A' }), song({ name: 'B' })];
        expect(filterSongsByPlayerFilters(songs, [])).toEqual(songs);
    });

    it('returns all songs when every filter is disabled', () => {
        const songs = [song({ name: 'A' }), song({ name: 'B' })];
        const filters = [filter({ isEnabled: false, operator: 'is', value: 'A' })];
        expect(filterSongsByPlayerFilters(songs, filters)).toEqual(songs);
    });

    it('ignores filters with an empty / null / undefined value', () => {
        const songs = [song({ name: 'A' })];
        expect(filterSongsByPlayerFilters(songs, [filter({ operator: 'is', value: '' })])).toEqual(
            songs,
        );
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ operator: 'is', value: null as unknown as string }),
            ]),
        ).toEqual(songs);
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ operator: 'is', value: undefined as unknown as string }),
            ]),
        ).toEqual(songs);
    });

    it('excludes songs whose field equals the value (is, case-insensitive)', () => {
        const songs = [song({ name: 'Keep' }), song({ name: 'Drop' })];
        const result = filterSongsByPlayerFilters(songs, [
            filter({ field: 'name', operator: 'is', value: 'drop' }),
        ]);
        expect(result.map((s) => s.name)).toEqual(['Keep']);
    });

    it('keeps songs whose field does NOT equal the value (isNot excludes the rest)', () => {
        const songs = [song({ name: 'Keep' }), song({ name: 'Drop' })];
        // isNot matches everything that is not 'keep' → those get excluded.
        const result = filterSongsByPlayerFilters(songs, [
            filter({ field: 'name', operator: 'isNot', value: 'keep' }),
        ]);
        expect(result.map((s) => s.name)).toEqual(['Keep']);
    });

    it('supports contains / notContains', () => {
        const songs = [song({ name: 'Live Recording' }), song({ name: 'Studio' })];
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'name', operator: 'contains', value: 'live' }),
            ]).map((s) => s.name),
        ).toEqual(['Studio']);
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'name', operator: 'notContains', value: 'live' }),
            ]).map((s) => s.name),
        ).toEqual(['Live Recording']);
    });

    it('supports startsWith / endsWith', () => {
        const songs = [song({ name: 'Intro Track' }), song({ name: 'Track Outro' })];
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'name', operator: 'startsWith', value: 'intro' }),
            ]).map((s) => s.name),
        ).toEqual(['Track Outro']);
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'name', operator: 'endsWith', value: 'outro' }),
            ]).map((s) => s.name),
        ).toEqual(['Intro Track']);
    });

    it('supports numeric gt / lt on duration', () => {
        const songs = [song({ duration: 100 }), song({ duration: 400 })];
        // gt: exclude songs with duration > 300
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'duration', operator: 'gt', value: 300 }),
            ]).map((s) => s.duration),
        ).toEqual([100]);
        // lt: exclude songs with duration < 300
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'duration', operator: 'lt', value: 300 }),
            ]).map((s) => s.duration),
        ).toEqual([400]);
    });

    it('supports regex and treats an invalid pattern as a non-match', () => {
        const songs = [song({ name: 'abc' }), song({ name: 'xyz' })];
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'name', operator: 'regex', value: '^a.c$' }),
            ]).map((s) => s.name),
        ).toEqual(['xyz']);
        // An invalid regex must not throw and must not match anything → all kept.
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'name', operator: 'regex', value: '(' }),
            ]).map((s) => s.name),
        ).toEqual(['abc', 'xyz']);
    });

    it('does not exclude a song when its field value is null', () => {
        const songs = [song({ duration: null })];
        expect(
            filterSongsByPlayerFilters(songs, [
                filter({ field: 'duration', operator: 'gt', value: 0 }),
            ]),
        ).toEqual(songs);
    });

    it('excludes a song that matches ANY of several filters', () => {
        const songs = [song({ name: 'A' }), song({ name: 'B' }), song({ name: 'C' })];
        const result = filterSongsByPlayerFilters(songs, [
            filter({ field: 'name', id: 'f1', operator: 'is', value: 'A' }),
            filter({ field: 'name', id: 'f2', operator: 'is', value: 'C' }),
        ]);
        expect(result.map((s) => s.name)).toEqual(['B']);
    });
});
