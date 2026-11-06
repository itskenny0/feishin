import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { getOptimizedListCount } from '/@/renderer/api/utils-list-count';
import {
    cachedSwr,
    cacheFavoriteCount,
    filterSongsLocal,
    LibraryCacheDb,
    loadSongsRows,
    readEntityCountFallback,
    readSnapshot,
    snapshotSwr,
    toCachedSongRow,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    AlbumRadioQuery,
    ArtistRadioQuery,
    GetQueueQuery,
    ListCountQuery,
    RandomSongListQuery,
    SimilarSongsQuery,
    Song,
    SongDetailQuery,
    SongListQuery,
    SongListResponse,
    SongListSort,
} from '/@/shared/types/domain-types';

// Filters only the full local-filter pass can answer (no index count).
const hasSongRowFilter = (q: ListCountQuery<SongListQuery>): boolean =>
    Boolean(
        q.searchTerm ||
        q.artistIds?.length ||
        q.genreIds?.length ||
        q.minYear !== undefined ||
        q.maxYear !== undefined ||
        q.hasRating !== undefined ||
        q.musicFolderId ||
        (q._custom && Object.keys(q._custom).length > 0),
    );

// The song list's pages come from the local filter (resolveSongPage), so its
// count must too: a shortcut that drops a filter shows phantom rows that
// sync-first never corrects. Index counts only when nothing else narrows.
const readSongCountFromCache = async (
    db: LibraryCacheDb,
    q: ListCountQuery<SongListQuery>,
): Promise<number | undefined> => {
    const albumId = q.albumIds?.length === 1 ? q.albumIds[0] : undefined;
    const albumArtistId = q.albumArtistIds?.length === 1 ? q.albumArtistIds[0] : undefined;

    if (!hasSongRowFilter(q) && !q.albumIds && !q.albumArtistIds) {
        if (q.favorite === undefined) {
            const count = await db.songs.count();
            return count > 0 ? count : undefined;
        }
        // Favourite-only: keeps the offline favourites list populated.
        const favRows = await db.favorites.where('ItemType').equals('Song').toArray();
        return cacheFavoriteCount({
            favorite: q.favorite,
            favoriteCount: favRows.filter((f) => f.IsFavorite).length,
            totalCount: q.favorite ? 0 : await db.songs.count(),
        });
    }

    if (!hasSongRowFilter(q) && q.favorite === undefined) {
        if (albumId && !q.albumArtistIds) {
            const count = await db.songs.where('AlbumId').equals(albumId).count();
            return count > 0 ? count : undefined;
        }
        if (albumArtistId && !q.albumIds) {
            const count = await db.songs.where('AlbumArtistId').equals(albumArtistId).count();
            return count > 0 ? count : undefined;
        }
    }

    const rows = albumId
        ? await db.songs.where('AlbumId').equals(albumId).toArray()
        : albumArtistId
          ? await db.songs.where('AlbumArtistId').equals(albumArtistId).toArray()
          : await loadSongsRows(db);
    if (rows.length === 0) return undefined;

    const favRows =
        q.favorite !== undefined || q.hasRating !== undefined
            ? await db.favorites.where('ItemType').equals('Song').toArray()
            : [];
    return (
        filterSongsLocal({
            favoriteSongIds:
                q.favorite !== undefined
                    ? new Set(favRows.filter((f) => f.IsFavorite).map((f) => f.ItemId))
                    : undefined,
            query: { ...q, limit: undefined, startIndex: 0 },
            ratedSongIds:
                q.hasRating !== undefined
                    ? new Set(
                          favRows
                              .filter((f) => typeof f.Rating === 'number' && f.Rating > 0)
                              .map((f) => f.ItemId),
                      )
                    : undefined,
            rows,
        })?.totalRecordCount ?? undefined
    );
};

export const songsQueries = {
    albumRadio: (args: QueryHookArgs<AlbumRadioQuery>) => {
        const key = queryKeys.songs.albumRadio(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<Song[]>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumRadio({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: {
                                albumId: args.query.albumId,
                                count: args.query.count ?? 20,
                            },
                        }) as Promise<Song[]>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    artistRadio: (args: QueryHookArgs<ArtistRadioQuery>) => {
        const key = queryKeys.songs.artistRadio(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<Song[]>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getArtistRadio({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: {
                                artistId: args.query.artistId,
                                count: args.query.count ?? 20,
                            },
                        }) as Promise<Song[]>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    detail: (args: QueryHookArgs<SongDetailQuery>) => {
        const key = queryKeys.songs.detail(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<Song>({
                    apply: async (db, fresh) => {
                        if (!fresh) return;
                        await db.songs.put(toCachedSongRow(fresh));
                    },
                    ctx,
                    fromCache: async (db) => {
                        if (!args.query?.id) return undefined;
                        const row = await db.songs.get(args.query.id);
                        return row?.Payload;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getSongDetail({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<Song>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    getQueue: (args: QueryHookArgs<GetQueueQuery>) => {
        const key = queryKeys.player.fetch({ type: 'queue' });
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getPlayQueue({
                            apiClientProps: { serverId: args.serverId, signal },
                        }),
                }),
            queryKey: key,
        });
    },
    list: (args: QueryHookArgs<SongListQuery>, imageSize?: number) => {
        const key = queryKeys.songs.list(args.serverId, { ...args.query, imageSize });
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<SongListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.songs.bulkPut(items.map(toCachedSongRow));
                        }
                    },
                    ctx,
                    fromCache: async (db) => {
                        // Mirror the album-list cache reader: pick the cheapest
                        // Dexie index available, then hand the row set to the
                        // shared local-filter pipeline so search/sort/pagination
                        // matches what the network would return.
                        let rows;
                        if (args.query?.albumIds && args.query.albumIds.length === 1) {
                            rows = await db.songs
                                .where('AlbumId')
                                .equals(args.query.albumIds[0])
                                .toArray();
                        } else if (
                            args.query?.albumArtistIds &&
                            args.query.albumArtistIds.length === 1
                        ) {
                            rows = await db.songs
                                .where('AlbumArtistId')
                                .equals(args.query.albumArtistIds[0])
                                .toArray();
                        } else {
                            rows = await db.songs.toArray();
                        }
                        if (rows.length === 0) return undefined;
                        let favoriteSongIds: Set<string> | undefined;
                        const needsFavorites =
                            args.query?.favorite !== undefined ||
                            args.query?.sortBy === SongListSort.FAVORITED;
                        if (needsFavorites) {
                            const favs = await db.favorites
                                .where('ItemType')
                                .equals('Song')
                                .toArray();
                            favoriteSongIds = new Set(
                                favs.filter((f) => f.IsFavorite).map((f) => f.ItemId),
                            );
                        }
                        const out = filterSongsLocal({
                            favoriteSongIds,
                            query: args.query,
                            rows,
                        });
                        return out as SongListResponse | undefined;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        controller.getSongList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: { ...args.query, imageSize },
                        }) as Promise<SongListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    listCount: (args: QueryHookArgs<ListCountQuery<SongListQuery>>) => {
        const key = queryKeys.songs.count(
            args.serverId,
            Object.keys(args.query).length === 0 ? undefined : args.query,
        );
        // A query with no row-narrowing filter can be answered by the exact,
        // sweep-maintained store count — seed it synchronously so the grid
        // doesn't suspend on a cold COUNT (perf fix #3). Filtered queries only
        // seed from the snapshot; the queryFn computes the real count.
        const q = args.query;
        const isUnfilteredSongCount =
            !hasSongRowFilter(q) && !q.albumIds && !q.albumArtistIds && q.favorite === undefined;
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() =>
                isUnfilteredSongCount
                    ? readEntityCountFallback(key, 'songs')
                    : readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: (db) => readSongCountFromCache(db, args.query),
                    queryKey: key,
                    remote: async ({ signal }) => {
                        const optimizedCount = await getOptimizedListCount<
                            ListCountQuery<SongListQuery>,
                            SongListQuery,
                            { totalRecordCount: null | number }
                        >({
                            client: ctx.client,
                            listQueryFn: controller.getSongList,
                            listQueryKeyFn: queryKeys.songs.list,
                            query: args.query,
                            serverId: args.serverId,
                            signal,
                        });

                        if (optimizedCount !== null) return optimizedCount;

                        return api.controller.getSongListCount({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        });
                    },
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
    random: (args: QueryHookArgs<RandomSongListQuery>) => {
        const key = queryKeys.songs.randomSongList(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                // Random results are server-side state with no faithful
                // Dexie reproduction. snapshotSwr preserves the previous
                // pick offline and prevents the queryFn from throwing on
                // network failure.
                snapshotSwr<SongListResponse>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getRandomSongList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<SongListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    similar: (args: QueryHookArgs<SimilarSongsQuery>) => {
        const key = queryKeys.songs.similar(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<Song[]>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getSimilarSongs({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: {
                                count: args.query.count ?? 50,
                                songId: args.query.songId,
                            },
                        }) as Promise<Song[]>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
};
