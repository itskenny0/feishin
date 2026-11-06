import { describe, expect, it } from 'vitest';

import {
    getArtistAlbumsGrouped,
    groupAlbumsByReleaseType,
} from '/@/renderer/features/artists/hooks/use-artist-albums-grouped';
import { ArtistReleaseTypeItem } from '/@/renderer/store';
import { Album, RelatedArtist } from '/@/shared/types/domain-types';

const ROUTE_ID = 'artist-1';

const relatedArtist = (id: string, name: string): RelatedArtist =>
    ({
        id,
        imageId: null,
        imageUrl: null,
        name,
        userFavorite: false,
        userRating: null,
    }) as unknown as RelatedArtist;

const album = (overrides: Partial<Album>): Album =>
    ({
        albumArtists: [relatedArtist(ROUTE_ID, 'Artist')],
        id: 'album',
        isCompilation: false,
        name: 'Album',
        releaseType: null,
        releaseTypes: [],
        ...overrides,
    }) as unknown as Album;

describe('groupAlbumsByReleaseType', () => {
    describe('primary grouping', () => {
        it('buckets albums whose artist is not an album artist under "appears-on"', () => {
            const albums = [album({ albumArtists: [relatedArtist('someone-else', 'Other')] })];

            const grouped = groupAlbumsByReleaseType(albums, ROUTE_ID, 'primary');

            expect(Object.keys(grouped)).toEqual(['appears-on']);
            expect(grouped['appears-on']).toHaveLength(1);
        });

        it('falls back to "album" when no release type is set', () => {
            const grouped = groupAlbumsByReleaseType([album({})], ROUTE_ID, 'primary');
            expect(grouped.album).toHaveLength(1);
        });

        it('prefers "album" over other present types', () => {
            const grouped = groupAlbumsByReleaseType(
                [album({ releaseTypes: ['single', 'album'] })],
                ROUTE_ID,
                'primary',
            );
            expect(grouped.album).toHaveLength(1);
            expect(grouped.single).toBeUndefined();
        });

        it('classifies a single when no album type is present', () => {
            const grouped = groupAlbumsByReleaseType(
                [album({ releaseType: 'single' })],
                ROUTE_ID,
                'primary',
            );
            expect(grouped.single).toHaveLength(1);
        });

        it('uses the first normalized type for a non-primary-only release', () => {
            const grouped = groupAlbumsByReleaseType(
                [album({ releaseTypes: ['live'] })],
                ROUTE_ID,
                'primary',
            );
            expect(grouped.live).toHaveLength(1);
        });
    });

    describe('all grouping', () => {
        it('buckets non-album-artist releases under "appears-on" before anything else', () => {
            const albums = [
                album({
                    albumArtists: [relatedArtist('someone-else', 'Other')],
                    isCompilation: true,
                }),
            ];

            const grouped = groupAlbumsByReleaseType(albums, ROUTE_ID, 'all');

            expect(Object.keys(grouped)).toEqual(['appears-on']);
        });

        it('buckets compilations under "compilation"', () => {
            const grouped = groupAlbumsByReleaseType(
                [album({ isCompilation: true })],
                ROUTE_ID,
                'all',
            );
            expect(grouped.compilation).toHaveLength(1);
        });

        it('joins multiple release types into a combined key with primaries first', () => {
            const grouped = groupAlbumsByReleaseType(
                [album({ releaseTypes: ['live', 'album'] })],
                ROUTE_ID,
                'all',
            );
            // album is primary (sorted first), live is secondary
            expect(grouped['album|live']).toHaveLength(1);
        });

        it('deduplicates equal release types from releaseTypes and releaseType', () => {
            const grouped = groupAlbumsByReleaseType(
                [album({ releaseType: 'album', releaseTypes: ['album'] })],
                ROUTE_ID,
                'all',
            );
            expect(grouped.album).toHaveLength(1);
        });

        it('falls back to "album" when there are no release types', () => {
            const grouped = groupAlbumsByReleaseType([album({})], ROUTE_ID, 'all');
            expect(grouped.album).toHaveLength(1);
        });
    });

    it('defaults to primary grouping when no grouping type is provided', () => {
        const grouped = groupAlbumsByReleaseType([album({})], ROUTE_ID);
        expect(grouped.album).toHaveLength(1);
    });
});

describe('getArtistAlbumsGrouped', () => {
    const t = ((key: string) => key) as never;
    const releaseTypeItems = (disabled: ArtistReleaseTypeItem[]) =>
        Object.values(ArtistReleaseTypeItem).map((id) => ({
            disabled: disabled.includes(id),
            id,
        }));

    // 'mixtape/street' contains the old '/' key separator, so it was split
    // into 'mixtape' + 'street', which match no setting: always shown.
    it.each(['primary', 'all'] as const)(
        'hides mixtape/street releases when Mixtape is disabled (%s grouping)',
        (grouping) => {
            const { releaseTypeEntries } = getArtistAlbumsGrouped(
                [album({ releaseTypes: ['mixtape/street'] })],
                ROUTE_ID,
                grouping,
                releaseTypeItems([ArtistReleaseTypeItem.RELEASE_TYPE_MIXTAPE_STREET]),
                t,
            );
            expect(releaseTypeEntries).toHaveLength(0);
        },
    );

    it('labels an album + mixtape/street release with both type names', () => {
        const { releaseTypeEntries } = getArtistAlbumsGrouped(
            [album({ releaseTypes: ['album', 'mixtape/street'] })],
            ROUTE_ID,
            'all',
            releaseTypeItems([]),
            t,
        );
        expect(releaseTypeEntries.map((e) => e.displayName)).toEqual([
            'releaseType.primary.album • releaseType.secondary.mixtape',
        ]);
    });
});
