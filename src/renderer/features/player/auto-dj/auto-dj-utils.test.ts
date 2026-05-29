// Unit tests for the pure Auto-DJ helpers.
//
// autoDjPushUniqueAlbumIds dedupes candidate album ids against both the
// already-seen set and the current-queue set (so Auto-DJ never re-adds an album
// that is already queued or already chosen). autoDjGenreIdsForSongGenre maps a
// song's genre to the id/name the per-server genre-song query expects.

import { describe, expect, it } from 'vitest';

import {
    autoDjGenreIdsForSongGenre,
    autoDjPushUniqueAlbumIds,
} from '/@/renderer/features/player/auto-dj/auto-dj-utils';
import { Genre, ServerType } from '/@/shared/types/domain-types';

const genre = (overrides: Partial<Genre>): Genre =>
    ({ id: 'genre-id', name: 'Rock', ...overrides }) as Genre;

describe('autoDjPushUniqueAlbumIds', () => {
    it('pushes new ids and records them as seen', () => {
        const acc: string[] = [];
        const seen = new Set<string>();
        const inQueue = new Set<string>();

        autoDjPushUniqueAlbumIds(acc, seen, inQueue, 'a', 'b');

        expect(acc).toEqual(['a', 'b']);
        expect(seen.has('a')).toBe(true);
        expect(seen.has('b')).toBe(true);
    });

    it('skips ids already present in the seen set', () => {
        const acc: string[] = [];
        const seen = new Set<string>(['a']);
        const inQueue = new Set<string>();

        autoDjPushUniqueAlbumIds(acc, seen, inQueue, 'a', 'b');

        expect(acc).toEqual(['b']);
    });

    it('skips ids already present in the current queue', () => {
        const acc: string[] = [];
        const seen = new Set<string>();
        const inQueue = new Set<string>(['b']);

        autoDjPushUniqueAlbumIds(acc, seen, inQueue, 'a', 'b');

        expect(acc).toEqual(['a']);
        // A queued id must not be marked as freshly-seen.
        expect(seen.has('b')).toBe(false);
    });

    it('dedupes repeated ids within a single call', () => {
        const acc: string[] = [];
        const seen = new Set<string>();
        const inQueue = new Set<string>();

        autoDjPushUniqueAlbumIds(acc, seen, inQueue, 'a', 'a', 'a');

        expect(acc).toEqual(['a']);
    });

    it('ignores undefined / empty ids', () => {
        const acc: string[] = [];
        const seen = new Set<string>();
        const inQueue = new Set<string>();

        autoDjPushUniqueAlbumIds(acc, seen, inQueue, undefined, '', 'a');

        expect(acc).toEqual(['a']);
    });
});

describe('autoDjGenreIdsForSongGenre', () => {
    it('uses the genre id for Jellyfin', () => {
        expect(
            autoDjGenreIdsForSongGenre(genre({ id: 'jf-id', name: 'Jazz' }), ServerType.JELLYFIN),
        ).toEqual(['jf-id']);
    });

    it('uses the genre name for Navidrome', () => {
        expect(
            autoDjGenreIdsForSongGenre(genre({ id: 'nd-id', name: 'Jazz' }), ServerType.NAVIDROME),
        ).toEqual(['Jazz']);
    });

    it('uses the genre name for Subsonic', () => {
        expect(
            autoDjGenreIdsForSongGenre(genre({ id: 'sub-id', name: 'Jazz' }), ServerType.SUBSONIC),
        ).toEqual(['Jazz']);
    });
});
