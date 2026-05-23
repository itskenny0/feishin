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
    AlbumRadioQuery,
    ArtistRadioQuery,
    GetQueueQuery,
    ListCountQuery,
    RandomSongListQuery,
    SimilarSongsQuery,
    SongListQuery,
} from '/@/shared/types/domain-types';

export const songsQueries = {
    albumRadio: (args: QueryHookArgs<AlbumRadioQuery>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getAlbumRadio({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: {
                        albumId: args.query.albumId,
                        count: args.query.count ?? 20,
                    },
                });
            },
            queryKey: queryKeys.songs.albumRadio(args.serverId, args.query),
            ...args.options,
        });
    },
    artistRadio: (args: QueryHookArgs<ArtistRadioQuery>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getArtistRadio({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: {
                        artistId: args.query.artistId,
                        count: args.query.count ?? 20,
                    },
                });
            },
            queryKey: queryKeys.songs.artistRadio(args.serverId, args.query),
            ...args.options,
        });
    },
    getQueue: (args: QueryHookArgs<GetQueueQuery>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getPlayQueue({
                    apiClientProps: { serverId: args.serverId, signal },
                });
            },
            queryKey: queryKeys.player.fetch({ type: 'queue' }),
        });
    },
    list: (args: QueryHookArgs<SongListQuery>, imageSize?: number) => {
        const key = queryKeys.songs.list(args.serverId, { ...args.query, imageSize });
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: async ({ signal }) => {
                const fresh = await controller.getSongList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: { ...args.query, imageSize },
                });
                writeSnapshot(key, fresh);
                return fresh;
            },
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
            queryFn: async ({ client, signal }) => {
                // Cache-first: an unfiltered song count comes straight from
                // `db.songs.count()` so the count tile / header paints
                // before the network revalidation lands.
                if (
                    isCacheAvailableSync() &&
                    !args.query.albumIds &&
                    !args.query.artistIds &&
                    !args.query.genreIds &&
                    args.query.favorite === undefined
                ) {
                    try {
                        const db = getActiveCacheDb();
                        if (db) {
                            const cachedCount = await db.songs.count();
                            if (cachedCount > 0) writeSnapshot(key, cachedCount);
                        }
                    } catch {
                        /* swallow */
                    }
                }

                const optimizedCount = await getOptimizedListCount<
                    ListCountQuery<SongListQuery>,
                    SongListQuery,
                    { totalRecordCount: null | number }
                >({
                    client,
                    listQueryFn: controller.getSongList,
                    listQueryKeyFn: queryKeys.songs.list,
                    query: args.query,
                    serverId: args.serverId,
                    signal,
                });

                if (optimizedCount !== null) {
                    writeSnapshot(key, optimizedCount);
                    return optimizedCount;
                }

                const fresh = await api.controller.getSongListCount({
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
    random: (args: QueryHookArgs<RandomSongListQuery>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getRandomSongList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
            },
            queryKey: queryKeys.songs.randomSongList(args.serverId, args.query),
            ...args.options,
        });
    },
    similar: (args: QueryHookArgs<SimilarSongsQuery>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.getSimilarSongs({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: {
                        count: args.query.count ?? 50,
                        songId: args.query.songId,
                    },
                });
            },
            queryKey: queryKeys.songs.similar(args.serverId, args.query),
            ...args.options,
        });
    },
};
