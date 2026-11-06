// Favourite-filtered song-artist list: the favourites sweep stores artist
// favourites under 'AlbumArtist' only, and the grid page resolver reads that
// bucket. The empty-state probe (useArtistListQuery) and the grid count
// (artistsQueries.artistListCount) read 'Artist', which only holds
// in-session toggles - so the favourite filter showed "No artists yet" or a
// truncated list.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedArgs {
    fromCache: (db: unknown) => Promise<unknown>;
}

vi.mock('/@/renderer/cache', async () => {
    const { cacheFavoriteCount, filterAlbumArtistsLocal, filterArtistsLocal } =
        await import('/@/renderer/cache/local-filter');
    return {
        cachedSwr: (args: CapturedArgs) => args.fromCache(mocks.db),
        cacheFavoriteCount,
        filterAlbumArtistsLocal,
        filterArtistsLocal,
        markRowsChangedFromPage: vi.fn(),
        markSearchDirty: vi.fn(),
        pageRefsFromItems: vi.fn(),
        readSnapshot: () => undefined,
        snapshotSwr: vi.fn(),
        toCachedArtistRow: vi.fn(),
        toCachedSongRow: vi.fn(),
        // Hand the hook's options back so the test can drive fromCache.
        useCachedQuery: (args: CapturedArgs) => args,
    };
});
vi.mock('/@/renderer/api', () => ({ api: { controller: {} } }));
vi.mock('/@/renderer/api/controller', () => ({ controller: {} }));
vi.mock('/@/renderer/api/utils-list-count', () => ({ getOptimizedListCount: vi.fn() }));
vi.mock('/@/renderer/lib/react-query', () => ({}));

const mocks = vi.hoisted(() => ({ db: undefined as unknown }));

import { artistsQueries } from '/@/renderer/features/artists/api/artists-api';
import { useArtistListQuery } from '/@/renderer/features/artists/queries/artists-queries';
import { ArtistListSort, SortOrder } from '/@/shared/types/domain-types';

const artistRow = (id: string) => ({
    __cachedAt: 0,
    DateLastSaved: '',
    Id: id,
    Kind: 'Artist',
    Name: id,
    Payload: { id, name: id },
    SortName: id,
});

const favorite = (id: string, ItemType: string) => ({
    __cachedAt: 0,
    IsFavorite: true,
    ItemId: id,
    ItemType,
    PlayCount: 0,
});

const makeDb = () => {
    const artists = ['a1', 'a2', 'a3'].map(artistRow);
    // What the favourites sweep writes: album-artist favourites, one of which
    // ('only-album-artist') has no song-artist row.
    const favorites = [
        favorite('a1', 'AlbumArtist'),
        favorite('a2', 'AlbumArtist'),
        favorite('only-album-artist', 'AlbumArtist'),
    ];
    return {
        artists: {
            where: () => ({
                equals: (kind: string) => {
                    const rows = artists.filter((a) => a.Kind === kind);
                    return {
                        primaryKeys: async () => rows.map((a) => a.Id),
                        toArray: async () => rows,
                    };
                },
            }),
        },
        favorites: {
            where: () => ({
                equals: (kind: string) => ({
                    toArray: async () => favorites.filter((f) => f.ItemType === kind),
                }),
            }),
        },
    };
};

const favoriteQuery = {
    favorite: true,
    sortBy: ArtistListSort.NAME,
    sortOrder: SortOrder.ASC,
    startIndex: 0,
};

beforeEach(() => {
    mocks.db = makeDb();
});

describe('favourite-filtered artist list reads the swept favourites bucket', () => {
    it('useArtistListQuery counts the favourite artists', async () => {
        const args = useArtistListQuery({
            query: { ...favoriteQuery, limit: 1 },
            serverId: 'server-1',
        }) as unknown as CapturedArgs;
        const result = (await args.fromCache(mocks.db)) as { totalRecordCount: number };
        expect(result.totalRecordCount).toBe(2);
    });

    it('artistListCount matches the list (favourites that are song artists)', async () => {
        const options = artistsQueries.artistListCount({
            query: favoriteQuery,
            serverId: 'server-1',
        });
        const queryFn = options.queryFn as unknown as (ctx: unknown) => Promise<number>;
        expect(await queryFn({ client: {}, signal: undefined })).toBe(2);
    });

    it('artistListCount for non-favourites subtracts only matching artists', async () => {
        const options = artistsQueries.artistListCount({
            query: { ...favoriteQuery, favorite: false },
            serverId: 'server-1',
        });
        const queryFn = options.queryFn as unknown as (ctx: unknown) => Promise<number>;
        expect(await queryFn({ client: {}, signal: undefined })).toBe(1);
    });
});
