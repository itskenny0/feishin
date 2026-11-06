// Cached query hooks for the artists feature.
//
// These wrap the controller calls with `useCachedQuery` so the IndexedDB
// cache primes the snapshot map before the network round-trip lands. The
// signatures match what the existing component callers expect once they
// migrate off the raw `useQuery(artistsQueries.X(...))` form: a
// `QueryHookArgs`-shaped input plus an `options.enabled` /
// `options.staleTime` pass-through.

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    filterAlbumArtistsLocal,
    filterArtistsLocal,
    LibraryCacheDb,
    markRowsChangedFromPage,
    markSearchDirty,
    pageRefsFromItems,
    useCachedQuery,
} from '/@/renderer/cache';
import {
    readArtistFavoriteSongsFromCache,
    readTopSongsFromCache,
} from '/@/renderer/features/artists/api/artists-api';
import {
    AlbumArtist,
    AlbumArtistDetailQuery,
    AlbumArtistDetailResponse,
    AlbumArtistInfoQuery,
    AlbumArtistInfoResponse,
    AlbumArtistListQuery,
    AlbumArtistListResponse,
    ArtistListQuery,
    ArtistListResponse,
    FavoriteSongListQuery,
    Song,
    SongListResponse,
    TopSongListQuery,
    TopSongListResponse,
} from '/@/shared/types/domain-types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ArtistsQueryArgs<TQuery> {
    options?: CachedQueryHookOptions;
    query: TQuery;
    serverId: string | undefined;
}

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

const nowMs = () => Date.now();

// Album-artist list queries can be served from the local cache when their
// filters map cleanly onto what the in-memory helper understands. Server-
// only flags (musicFolderId, custom backend tags) force a network round.
const canServeAlbumArtistFromCache = (query: AlbumArtistListQuery | undefined): boolean => {
    if (!query) return true;
    if (query.musicFolderId !== undefined) return false;
    if (query._custom !== undefined) return false;
    return true;
};

const canServeArtistFromCache = (query: ArtistListQuery | undefined): boolean => {
    if (!query) return true;
    if (query.musicFolderId !== undefined) return false;
    if (query.role) return false;
    if (query._custom !== undefined) return false;
    return true;
};

// Build a Set of favorited artist IDs from the favorites table - used only
// when the query opts into favorite-filtering. Both artist kinds read the
// 'AlbumArtist' bucket: it is the only one the favourites sweep writes
// (Jellyfin/Navidrome share one favourite record between the two kinds),
// and the grid page resolvers read it too, so counts and lists agree.
const readFavoriteArtistIds = async (db: LibraryCacheDb): Promise<Set<string>> => {
    const rows = await db.favorites.where('ItemType').equals('AlbumArtist').toArray();
    return new Set(rows.filter((r) => r.IsFavorite).map((r) => r.ItemId));
};

const toCachedArtistRow = (artist: AlbumArtist, kind: 'AlbumArtist' | 'Artist') => ({
    __cachedAt: nowMs(),
    AlbumArtistId: artist.id,
    DateLastSaved: artist.lastPlayedAt ?? '',
    Id: artist.id,
    Kind: kind,
    Name: artist.name ?? '',
    Payload: artist,
    SortName: (artist.name ?? '').toLowerCase(),
});

const toCachedSongRow = (song: Song) => ({
    __cachedAt: nowMs(),
    AlbumArtistId: song.albumArtists?.[0]?.id ?? undefined,
    AlbumId: song.albumId,
    DateLastSaved: song.updatedAt ?? song.lastPlayedAt ?? '',
    Id: song.id,
    IndexNumber: song.trackNumber,
    ParentIndexNumber: song.discNumber,
    Payload: song,
});

const writeArtistRows = async (
    db: LibraryCacheDb,
    items: AlbumArtist[],
    kind: 'AlbumArtist' | 'Artist',
): Promise<void> => {
    if (items.length === 0) return;
    await db.artists.bulkPut(items.map((a) => toCachedArtistRow(a, kind)));
    markSearchDirty('artists');
    markRowsChangedFromPage('artists', pageRefsFromItems(items));
};

const writeSongRows = async (db: LibraryCacheDb, items: Song[]): Promise<void> => {
    if (items.length === 0) return;
    await db.songs.bulkPut(items.map(toCachedSongRow));
    markSearchDirty('songs');
    markRowsChangedFromPage('songs', pageRefsFromItems(items));
};

// ---------------------------------------------------------------------------
// Album-artist list
// ---------------------------------------------------------------------------

export const useAlbumArtistListQuery = (args: ArtistsQueryArgs<AlbumArtistListQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<AlbumArtistListResponse>({
        apply: (db, fresh) => writeArtistRows(db, fresh?.items ?? [], 'AlbumArtist'),
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db) => {
            if (!canServeAlbumArtistFromCache(query)) return undefined;
            const rows = await db.artists.where('Kind').equals('AlbumArtist').toArray();
            if (rows.length === 0) return undefined;
            const favoriteArtistIds =
                query?.favorite !== undefined ? await readFavoriteArtistIds(db) : undefined;
            return filterAlbumArtistsLocal({
                favoriteArtistIds,
                query: query ?? ({} as AlbumArtistListQuery),
                rows,
            });
        },
        queryKey: queryKeys.albumArtists.list(serverId ?? '', query),
        remote: (ctx) =>
            controller.getAlbumArtistList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<AlbumArtistListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Album-artist detail
// ---------------------------------------------------------------------------

export const useAlbumArtistDetailQuery = (args: ArtistsQueryArgs<AlbumArtistDetailQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<AlbumArtistDetailResponse>({
        apply: async (db, fresh) => {
            if (fresh) await writeArtistRows(db, [fresh], 'AlbumArtist');
        },
        enabled: options?.enabled ?? Boolean(serverId && query?.id),
        fromCache: async (db) => {
            if (!query?.id) return undefined;
            const row = await db.artists.get(query.id);
            return row?.Payload ?? undefined;
        },
        queryKey: queryKeys.albumArtists.detail(serverId ?? '', query),
        remote: (ctx) =>
            controller.getAlbumArtistDetail({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<AlbumArtistDetailResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Album-artist info (biography, similar artists)
// ---------------------------------------------------------------------------

export const useAlbumArtistInfoQuery = (args: ArtistsQueryArgs<AlbumArtistInfoQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<AlbumArtistInfoResponse | null>({
        // Info is a server-side extended-metadata blob (similarArtists,
        // remote biography). There's no first-class cache row for it —
        // persist nothing locally and rely on the snapshot map for
        // remount-warmth.
        enabled: options?.enabled ?? Boolean(serverId && query?.id),
        queryKey: queryKeys.albumArtists.info(serverId ?? '', query),
        remote: (ctx) =>
            (controller.getAlbumArtistInfo?.({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) ?? Promise.resolve(null)) as Promise<AlbumArtistInfoResponse | null>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Top songs (per artist)
// ---------------------------------------------------------------------------

export const useArtistTopSongsQuery = (args: ArtistsQueryArgs<TopSongListQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<TopSongListResponse>({
        apply: (db, fresh) => writeSongRows(db, fresh?.items ?? []),
        enabled: options?.enabled ?? Boolean(serverId && query?.artistId),
        // Server ranks by popularity which we can't reproduce, but on
        // cold-offline an approximation is far better than an infinite
        // spinner on one of the most-hit surfaces.
        fromCache: (db) => readTopSongsFromCache(db, query),
        queryKey: queryKeys.albumArtists.topSongs(serverId ?? '', query),
        remote: (ctx) =>
            controller.getTopSongs({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<TopSongListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Favorite songs (per artist)
// ---------------------------------------------------------------------------

export const useArtistFavoriteSongsQuery = (args: ArtistsQueryArgs<FavoriteSongListQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<SongListResponse>({
        apply: (db, fresh) => writeSongRows(db, fresh?.items ?? []),
        enabled: options?.enabled ?? Boolean(serverId && query?.artistId),
        // Intersect cached songs by this artist with the favorites table so
        // the artist page's "Favorite songs" section paints offline instead
        // of spinning. Network revalidate still wins for the canonical
        // ordering when it lands.
        fromCache: (db) => readArtistFavoriteSongsFromCache(db, query),
        queryKey: queryKeys.albumArtists.favoriteSongs(serverId ?? '', query),
        remote: (ctx) =>
            controller.getFavoriteSongs({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<SongListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Song-artist list
// ---------------------------------------------------------------------------

export const useArtistListQuery = (args: ArtistsQueryArgs<ArtistListQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<ArtistListResponse>({
        apply: (db, fresh) => writeArtistRows(db, fresh?.items ?? [], 'Artist'),
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db) => {
            if (!canServeArtistFromCache(query)) return undefined;
            const rows = await db.artists.where('Kind').equals('Artist').toArray();
            if (rows.length === 0) return undefined;
            const favoriteArtistIds =
                query?.favorite !== undefined ? await readFavoriteArtistIds(db) : undefined;
            return filterArtistsLocal({
                favoriteArtistIds,
                query: query ?? ({} as ArtistListQuery),
                rows,
            });
        },
        queryKey: queryKeys.artists.list(serverId ?? '', query),
        remote: (ctx) =>
            controller.getArtistList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<ArtistListResponse>,
        staleTime: options?.staleTime,
    });
};
