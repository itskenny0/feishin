import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { getOptimizedListCount } from '/@/renderer/api/utils-list-count';
import {
    getActiveCacheDb,
    isCacheAvailableSync,
    readSnapshot,
    writeSnapshot,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    AlbumArtistDetailQuery,
    AlbumArtistInfoQuery,
    AlbumArtistListQuery,
    ArtistListQuery,
    ListCountQuery,
    SongListSort,
    SortOrder,
    TopSongListQuery,
} from '/@/shared/types/domain-types';

export const artistsQueries = {
    albumArtistDetail: (args: QueryHookArgs<AlbumArtistDetailQuery>) => {
        const key = queryKeys.albumArtists.detail(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                // Dexie read-through: paint the cached artist payload while
                // the network call is in flight. Works for both the
                // suspense and non-suspense callers because we seed the
                // snapshot map before the controller resolves.
                if (isCacheAvailableSync() && args.query?.id) {
                    try {
                        const db = getActiveCacheDb();
                        const row = await db?.artists.get(args.query.id);
                        if (row?.Payload) writeSnapshot(key, row.Payload);
                    } catch {
                        /* cache reads must never break the query */
                    }
                }
                const fresh = await api.controller.getAlbumArtistDetail({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
    albumArtistInfo: (args: QueryHookArgs<AlbumArtistInfoQuery>) => {
        const key = queryKeys.albumArtists.info(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await (api.controller.getAlbumArtistInfo?.({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                }) ?? Promise.resolve(null));
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
    albumArtistList: (args: QueryHookArgs<AlbumArtistListQuery>) => {
        const key = queryKeys.albumArtists.list(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getAlbumArtistList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
    albumArtistListCount: (args: QueryHookArgs<ListCountQuery<AlbumArtistListQuery>>) => {
        const key = queryKeys.albumArtists.count(
            args.serverId,
            Object.keys(args.query).length === 0 ? undefined : args.query,
        );
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ client, signal }) => {
                if (
                    isCacheAvailableSync() &&
                    args.query.favorite === undefined &&
                    !args.query._custom
                ) {
                    try {
                        const db = getActiveCacheDb();
                        if (db) {
                            const cachedCount = await db.artists
                                .where('Kind')
                                .equals('AlbumArtist')
                                .count();
                            if (cachedCount > 0) writeSnapshot(key, cachedCount);
                        }
                    } catch {
                        /* swallow */
                    }
                }

                const optimizedCount = await getOptimizedListCount<
                    ListCountQuery<AlbumArtistListQuery>,
                    AlbumArtistListQuery,
                    { totalRecordCount: null | number }
                >({
                    client,
                    listQueryFn: controller.getAlbumArtistList,
                    listQueryKeyFn: queryKeys.albumArtists.list,
                    query: args.query,
                    serverId: args.serverId,
                    signal,
                });

                if (optimizedCount !== null) {
                    writeSnapshot(key, optimizedCount);
                    return optimizedCount;
                }

                const fresh = await api.controller.getAlbumArtistListCount({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
    artistList: (args: QueryHookArgs<ArtistListQuery>) => {
        const key = queryKeys.artists.list(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getArtistList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
    artistListCount: (args: QueryHookArgs<ListCountQuery<ArtistListQuery>>) => {
        const key = queryKeys.artists.count(
            args.serverId,
            Object.keys(args.query).length === 0 ? undefined : args.query,
        );
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ client, signal }) => {
                if (
                    isCacheAvailableSync() &&
                    args.query.favorite === undefined &&
                    !args.query._custom
                ) {
                    try {
                        const db = getActiveCacheDb();
                        if (db) {
                            const cachedCount = await db.artists
                                .where('Kind')
                                .equals('Artist')
                                .count();
                            if (cachedCount > 0) writeSnapshot(key, cachedCount);
                        }
                    } catch {
                        /* swallow */
                    }
                }

                const optimizedCount = await getOptimizedListCount<
                    ListCountQuery<ArtistListQuery>,
                    ArtistListQuery,
                    { totalRecordCount: null | number }
                >({
                    client,
                    listQueryFn: controller.getArtistList,
                    listQueryKeyFn: queryKeys.artists.list,
                    query: args.query,
                    serverId: args.serverId,
                    signal,
                });

                if (optimizedCount !== null) {
                    writeSnapshot(key, optimizedCount);
                    return optimizedCount;
                }

                const fresh = await api.controller
                    .getArtistList({
                        apiClientProps: { serverId: args.serverId, signal },
                        query: { ...args.query, limit: 1, startIndex: 0 },
                    })
                    .then((result) => result?.totalRecordCount ?? 0);
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
    favoriteSongs: (args: QueryHookArgs<{ artistId: string }>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getSongList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: {
                        artistIds: [args.query.artistId],
                        favorite: true,
                        limit: -1,
                        sortBy: SongListSort.RELEASE_DATE,
                        sortOrder: SortOrder.ASC,
                        startIndex: 0,
                    },
                });
            },
            queryKey: queryKeys.albumArtists.favoriteSongs(args.serverId, args.query.artistId),
        });
    },
    topSongs: (args: QueryHookArgs<TopSongListQuery>) => {
        const key = queryKeys.albumArtists.topSongs(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await api.controller.getTopSongs({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
            queryKey: key,
            ...args.options,
        });
    },
};
