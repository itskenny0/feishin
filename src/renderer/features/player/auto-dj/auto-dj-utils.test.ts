// Unit tests for the pure Auto-DJ helpers.
//
// autoDjGenreIdsForSongGenre maps a song's genre to the id/name the
// per-server genre-song query expects.

import { describe, expect, it } from 'vitest';

import { autoDjGenreIdsForSongGenre } from '/@/renderer/features/player/auto-dj/auto-dj-utils';
import { Genre, ServerType } from '/@/shared/types/domain-types';

const genre = (overrides: Partial<Genre>): Genre =>
    ({ id: 'genre-id', name: 'Rock', ...overrides }) as Genre;

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
