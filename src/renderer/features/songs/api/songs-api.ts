import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { getOptimizedListCount } from '/@/renderer/api/utils-list-count';
import {
    cachedSwr,
    filterSongsLocal,
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
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
                        if (args.query.searchTerm) {
                            const rows = await db.songs.toArray();
                            const result = filterSongsLocal({
                                query: { ...args.query, startIndex: 0 },
                                rows,
                            });
                            if (result !== undefined) return result.totalRecordCount ?? 0;
                        }
                        if (
                            args.query.genreIds?.length &&
                            !args.query.albumIds &&
                            !args.query.artistIds
                        ) {
                            const rows = await db.songs.toArray();
                            const result = filterSongsLocal({
                                query: { ...args.query, startIndex: 0 },
                                rows,
                            });
                            if (result !== undefined) return result.totalRecordCount ?? 0;
                        }
                        // Serve favorite-only count from Dexie so the favorites songs
                        // list is not empty offline (the list query already serves items
                        // from cache; without a count the virtual scroll renders 0 rows).
                        if (
                            args.query.favorite !== undefined &&
                            !args.query.albumIds &&
                            !args.query.artistIds &&
                            !args.query.genreIds?.length
                        ) {
                            const favRows = await db.favorites
                                .where('ItemType')
                                .equals('Song')
                                .toArray();
                            if (args.query.favorite === true) {
                                return favRows.filter((f) => f.IsFavorite).length;
                            }
                            const favCount = favRows.filter((f) => f.IsFavorite).length;
                            const total = await db.songs.count();
                            return total > 0 ? total - favCount : 0;
                        }
                        // Single-album or single-albumArtist count is cheap via Dexie
                        // index and avoids the virtual scroll thinking there are N total
                        // songs when only a subset belongs to this album/artist.
                        if (args.query.albumIds?.length === 1 && !args.query.artistIds) {
                            const count = await db.songs
                                .where('AlbumId')
                                .equals(args.query.albumIds[0])
                                .count();
                            return count > 0 ? count : undefined;
                        }
                        if (
                            args.query.albumArtistIds?.length === 1 &&
                            !args.query.albumIds &&
                            !args.query.artistIds
                        ) {
                            const count = await db.songs
                                .where('AlbumArtistId')
                                .equals(args.query.albumArtistIds[0])
                                .count();
                            return count > 0 ? count : undefined;
                        }
                        if (
                            args.query.albumIds ||
                            args.query.artistIds ||
                            args.query.genreIds ||
                            args.query.albumArtistIds
                        ) {
                            return undefined;
                        }
                        const cachedCount = await db.songs.count();
                        return cachedCount > 0 ? cachedCount : undefined;
                    },
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
