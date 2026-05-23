// Cached query hooks for the artists feature.
//
// These wrap the controller calls with `useCachedQuery` /
// `useCachedInfiniteQuery` so the IndexedDB cache primes the snapshot map
// before the network round-trip lands. The signatures match what the
// existing component callers expect once they migrate off the raw
// `useQuery(artistsQueries.X(...))` form: a `QueryHookArgs`-shaped input
// plus an `options.enabled` / `options.staleTime` pass-through.

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    filterAlbumArtistsLocal,
    filterArtistsLocal,
    LibraryCacheDb,
    markSearchDirty,
    useCachedInfiniteQuery,
    useCachedQuery,
} from '/@/renderer/cache';
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
    Song,
    SongListResponse,
    SongListSort,
    SortOrder,
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

// Build a Set of favorited AlbumArtist IDs from the favorites table — used
// only when the query opts into favorite-filtering. Caller decides whether
// to spend the read.
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

// ---------------------------------------------------------------------------
// Album-artist list (paginated)
// ---------------------------------------------------------------------------

export const useAlbumArtistListQuery = (args: ArtistsQueryArgs<AlbumArtistListQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<AlbumArtistListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.artists.bulkPut(items.map((a) => toCachedArtistRow(a, 'AlbumArtist')));
            markSearchDirty('artists');
        },
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
// Album-artist list (infinite)
// ---------------------------------------------------------------------------

interface AlbumArtistInfiniteListArgs {
    itemLimit: number;
    options?: CachedQueryHookOptions;
    query: Omit<AlbumArtistListQuery, 'startIndex'>;
    serverId: string | undefined;
}

export const useAlbumArtistInfiniteListQuery = (args: AlbumArtistInfiniteListArgs) => {
    const { itemLimit, options, query, serverId } = args;

    return useCachedInfiniteQuery<AlbumArtistListResponse, number>({
        apply: async (db, page) => {
            const items = page?.items ?? [];
            if (items.length === 0) return;
            await db.artists.bulkPut(items.map((a) => toCachedArtistRow(a, 'AlbumArtist')));
            markSearchDirty('artists');
        },
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db, pageParam) => {
            const fullQuery = query as AlbumArtistListQuery;
            if (!canServeAlbumArtistFromCache(fullQuery)) return undefined;
            const rows = await db.artists.where('Kind').equals('AlbumArtist').toArray();
            if (rows.length === 0) return undefined;
            const favoriteArtistIds =
                fullQuery?.favorite !== undefined ? await readFavoriteArtistIds(db) : undefined;
            return filterAlbumArtistsLocal({
                favoriteArtistIds,
                query: {
                    ...fullQuery,
                    limit: itemLimit,
                    startIndex: pageParam ?? 0,
                },
                rows,
            });
        },
        getNextPageParam: (lastPage, _allPages, lastPageParam) => {
            if (!lastPage || lastPage.items.length < itemLimit) return undefined;
            return Number(lastPageParam) + itemLimit;
        },
        initialPageParam: 0,
        queryKey: queryKeys.albumArtists.infiniteList(serverId ?? '', {
            ...(query as AlbumArtistListQuery),
            startIndex: 0,
        }),
        remote: (ctx) =>
            controller.getAlbumArtistList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: {
                    ...(query as AlbumArtistListQuery),
                    limit: itemLimit,
                    startIndex: ctx.pageParam as number,
                },
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
            if (!fresh) return;
            await db.artists.put(toCachedArtistRow(fresh, 'AlbumArtist'));
            markSearchDirty('artists');
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
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.songs.bulkPut(items.map(toCachedSongRow));
            markSearchDirty('songs');
        },
        enabled: options?.enabled ?? Boolean(serverId && query?.artistId),
        // Top-songs ordering is server-defined (popularity, listener count,
        // etc.) so reading by AlbumArtistId would lose that signal — skip
        // the cache read and let the network call answer authoritatively.
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

interface FavoriteSongsArgs {
    options?: CachedQueryHookOptions;
    query: { artistId: string };
    serverId: string | undefined;
}

export const useArtistFavoriteSongsQuery = (args: FavoriteSongsArgs) => {
    const { options, query, serverId } = args;

    return useCachedQuery<SongListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.songs.bulkPut(items.map(toCachedSongRow));
            markSearchDirty('songs');
        },
        enabled: options?.enabled ?? Boolean(serverId && query?.artistId),
        // Favorite state is owned by the favorites table and the server
        // is the source of truth — skip cache reads, just warm from the
        // snapshot map.
        queryKey: queryKeys.albumArtists.favoriteSongs(serverId ?? '', query.artistId),
        remote: (ctx) =>
            controller.getSongList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: {
                    artistIds: [query.artistId],
                    favorite: true,
                    limit: -1,
                    sortBy: SongListSort.RELEASE_DATE,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
            }) as Promise<SongListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Song-artist list (paginated)
// ---------------------------------------------------------------------------

export const useArtistListQuery = (args: ArtistsQueryArgs<ArtistListQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<ArtistListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.artists.bulkPut(items.map((a) => toCachedArtistRow(a, 'Artist')));
            markSearchDirty('artists');
        },
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

// ---------------------------------------------------------------------------
// Song-artist list (infinite)
// ---------------------------------------------------------------------------

interface ArtistInfiniteListArgs {
    itemLimit: number;
    options?: CachedQueryHookOptions;
    query: Omit<ArtistListQuery, 'startIndex'>;
    serverId: string | undefined;
}

export const useArtistInfiniteListQuery = (args: ArtistInfiniteListArgs) => {
    const { itemLimit, options, query, serverId } = args;

    return useCachedInfiniteQuery<ArtistListResponse, number>({
        apply: async (db, page) => {
            const items = page?.items ?? [];
            if (items.length === 0) return;
            await db.artists.bulkPut(items.map((a) => toCachedArtistRow(a, 'Artist')));
            markSearchDirty('artists');
        },
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db, pageParam) => {
            const fullQuery = query as ArtistListQuery;
            if (!canServeArtistFromCache(fullQuery)) return undefined;
            const rows = await db.artists.where('Kind').equals('Artist').toArray();
            if (rows.length === 0) return undefined;
            const favoriteArtistIds =
                fullQuery?.favorite !== undefined ? await readFavoriteArtistIds(db) : undefined;
            return filterArtistsLocal({
                favoriteArtistIds,
                query: {
                    ...fullQuery,
                    limit: itemLimit,
                    startIndex: pageParam ?? 0,
                },
                rows,
            });
        },
        getNextPageParam: (lastPage, _allPages, lastPageParam) => {
            if (!lastPage || lastPage.items.length < itemLimit) return undefined;
            return Number(lastPageParam) + itemLimit;
        },
        initialPageParam: 0,
        queryKey: queryKeys.artists.infiniteList(serverId ?? '', {
            ...(query as ArtistListQuery),
            startIndex: 0,
        }),
        remote: (ctx) =>
            controller.getArtistList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: {
                    ...(query as ArtistListQuery),
                    limit: itemLimit,
                    startIndex: ctx.pageParam as number,
                },
            }) as Promise<ArtistListResponse>,
        staleTime: options?.staleTime,
    });
};
