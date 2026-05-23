import { queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { getOptimizedListCount } from '/@/renderer/api/utils-list-count';
import {
    cachedSwr,
    readSnapshot,
    snapshotSwr,
    toCachedArtistRow,
    toCachedSongRow,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    AlbumArtistDetailQuery,
    AlbumArtistDetailResponse,
    AlbumArtistInfoQuery,
    AlbumArtistInfoResponse,
    AlbumArtistListQuery,
    AlbumArtistListResponse,
    ArtistListQuery,
    ArtistListResponse,
    ListCountQuery,
    SongListResponse,
    SongListSort,
    SortOrder,
    TopSongListQuery,
    TopSongListResponse,
} from '/@/shared/types/domain-types';

export const artistsQueries = {
    albumArtistDetail: (args: QueryHookArgs<AlbumArtistDetailQuery>) => {
        const key = queryKeys.albumArtists.detail(args.serverId, args.query);
        return queryOptions({
            initialData: () => readSnapshot<AlbumArtistDetailResponse>(key),
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<AlbumArtistDetailResponse>({
                    apply: async (db, fresh) => {
                        if (!fresh) return;
                        await db.artists.put(toCachedArtistRow(fresh, 'AlbumArtist'));
                    },
                    ctx,
                    fromCache: async (db) => {
                        if (!args.query?.id) return undefined;
                        const row = await db.artists.get(args.query.id);
                        return (row?.Payload ?? undefined) as
                            | AlbumArtistDetailResponse
                            | undefined;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumArtistDetail({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<AlbumArtistDetailResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
    albumArtistInfo: (args: QueryHookArgs<AlbumArtistInfoQuery>) => {
        const key = queryKeys.albumArtists.info(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<AlbumArtistInfoResponse | null>({
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumArtistInfo?.({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) ?? Promise.resolve(null),
                }),
            queryKey: key,
            ...args.options,
        });
    },
    albumArtistList: (args: QueryHookArgs<AlbumArtistListQuery>) => {
        const key = queryKeys.albumArtists.list(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<AlbumArtistListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.artists.bulkPut(
                                items.map((a) => toCachedArtistRow(a, 'AlbumArtist')),
                            );
                        }
                    },
                    ctx,
                    fromCache: async (db) => {
                        // Serve the artist list from Dexie so the page paints
                        // on cold mount and works offline.
                        const rows = await db.artists
                            .where('Kind')
                            .equals('AlbumArtist')
                            .toArray();
                        if (rows.length === 0) return undefined;
                        rows.sort((a, b) =>
                            (a.SortName ?? '').localeCompare(b.SortName ?? ''),
                        );
                        const items = rows.map((r) => r.Payload);
                        return {
                            items,
                            startIndex: 0,
                            totalRecordCount: items.length,
                        };
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getAlbumArtistList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<AlbumArtistListResponse>,
                }),
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
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
                        if (args.query.favorite !== undefined || args.query._custom) {
                            return undefined;
                        }
                        const cachedCount = await db.artists
                            .where('Kind')
                            .equals('AlbumArtist')
                            .count();
                        return cachedCount > 0 ? cachedCount : undefined;
                    },
                    queryKey: key,
                    remote: async ({ signal }) => {
                        const optimizedCount = await getOptimizedListCount<
                            ListCountQuery<AlbumArtistListQuery>,
                            AlbumArtistListQuery,
                            { totalRecordCount: null | number }
                        >({
                            client: ctx.client,
                            listQueryFn: controller.getAlbumArtistList,
                            listQueryKeyFn: queryKeys.albumArtists.list,
                            query: args.query,
                            serverId: args.serverId,
                            signal,
                        });

                        if (optimizedCount !== null) return optimizedCount;

                        return api.controller.getAlbumArtistListCount({
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
    artistList: (args: QueryHookArgs<ArtistListQuery>) => {
        const key = queryKeys.artists.list(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<ArtistListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.artists.bulkPut(
                                items.map((a) => toCachedArtistRow(a, 'Artist')),
                            );
                        }
                    },
                    ctx,
                    fromCache: async (db) => {
                        const rows = await db.artists
                            .where('Kind')
                            .equals('Artist')
                            .toArray();
                        if (rows.length === 0) return undefined;
                        rows.sort((a, b) =>
                            (a.SortName ?? '').localeCompare(b.SortName ?? ''),
                        );
                        const items = rows.map((r) => r.Payload);
                        return {
                            items,
                            startIndex: 0,
                            totalRecordCount: items.length,
                        };
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getArtistList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<ArtistListResponse>,
                }),
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
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
                        if (args.query.favorite !== undefined || args.query._custom) {
                            return undefined;
                        }
                        const cachedCount = await db.artists
                            .where('Kind')
                            .equals('Artist')
                            .count();
                        return cachedCount > 0 ? cachedCount : undefined;
                    },
                    queryKey: key,
                    remote: async ({ signal }) => {
                        const optimizedCount = await getOptimizedListCount<
                            ListCountQuery<ArtistListQuery>,
                            ArtistListQuery,
                            { totalRecordCount: null | number }
                        >({
                            client: ctx.client,
                            listQueryFn: controller.getArtistList,
                            listQueryKeyFn: queryKeys.artists.list,
                            query: args.query,
                            serverId: args.serverId,
                            signal,
                        });

                        if (optimizedCount !== null) return optimizedCount;

                        return api.controller
                            .getArtistList({
                                apiClientProps: { serverId: args.serverId, signal },
                                query: { ...args.query, limit: 1, startIndex: 0 },
                            })
                            .then((result) => result?.totalRecordCount ?? 0);
                    },
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
    favoriteSongs: (args: QueryHookArgs<{ artistId: string }>) => {
        const key = queryKeys.albumArtists.favoriteSongs(args.serverId, args.query.artistId);
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
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getSongList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: {
                                artistIds: [args.query.artistId],
                                favorite: true,
                                limit: -1,
                                sortBy: SongListSort.RELEASE_DATE,
                                sortOrder: SortOrder.ASC,
                                startIndex: 0,
                            },
                        }) as Promise<SongListResponse>,
                }),
            queryKey: key,
        });
    },
    topSongs: (args: QueryHookArgs<TopSongListQuery>) => {
        const key = queryKeys.albumArtists.topSongs(args.serverId, args.query);
        return queryOptions({
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<TopSongListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.songs.bulkPut(items.map(toCachedSongRow));
                        }
                    },
                    ctx,
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getTopSongs({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<TopSongListResponse>,
                }),
            queryKey: key,
            ...args.options,
        });
    },
};
