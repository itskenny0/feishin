// Cached query hooks for the playlists feature.
//
// These wrap the controller calls with `useCachedQuery` (plus a hand-rolled
// suspense variant) so the IndexedDB cache primes the snapshot map before
// the network round-trip lands. Same pattern as `genres-queries.ts`.
//
// Playlist sweeps prime `db.playlists` for the list query. The detail row
// is a single playlist payload (also reused from the list sweep). Playlist
// songs are write-through only — Jellyfin / Subsonic don't expose a bulk
// playlist-songs endpoint, so we cannot pre-hydrate, but once a user opens
// a playlist its songs land in `db.playlistSongs` and subsequent mounts
// paint instantly.

import type { QueryKey } from '@tanstack/react-query';

import { useQuery, useSuspenseQuery } from '@tanstack/react-query';

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    getActiveCacheDb,
    isCacheAvailableSync,
    markSearchDirty,
    readSnapshot,
    useCachedQuery,
    writeSnapshot,
} from '/@/renderer/cache';
import { queryClient } from '/@/renderer/lib/react-query';
import {
    Playlist,
    PlaylistDetailQuery,
    PlaylistDetailResponse,
    PlaylistListQuery,
    PlaylistListResponse,
    PlaylistListSort,
    PlaylistSongListQuery,
    PlaylistSongListResponse,
    SortOrder,
} from '/@/shared/types/domain-types';

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

interface PlaylistDetailHookOptions extends CachedQueryHookOptions {
    // Allow the caller (e.g. the song-list header that seeds from React
    // Router navigation state) to override the wrapper's snapshot-based
    // placeholderData. When provided, this wins over the IDB snapshot.
    placeholderData?: PlaylistDetailResponse | undefined;
}

interface PlaylistDetailQueryArgs {
    options?: PlaylistDetailHookOptions;
    query: PlaylistDetailQuery;
    serverId: string | undefined;
}

interface PlaylistDetailSuspenseQueryArgs extends PlaylistDetailQueryArgs {
    queryKey?: QueryKey;
}

interface PlaylistListQueryArgs {
    options?: CachedQueryHookOptions;
    query: PlaylistListQuery;
    serverId: string | undefined;
}

interface PlaylistListSuspenseQueryArgs extends PlaylistListQueryArgs {
    queryKey?: QueryKey;
}

interface PlaylistSongListQueryArgs {
    options?: CachedQueryHookOptions;
    playlistId: string;
    query?: Omit<PlaylistSongListQuery, 'id'>;
    serverId: string | undefined;
}

interface PlaylistSongListSuspenseQueryArgs extends PlaylistSongListQueryArgs {
    queryKey?: QueryKey;
}

const nowMs = () => Date.now();

const toCachedPlaylistRow = (playlist: Playlist) => ({
    __cachedAt: nowMs(),
    DateLastSaved: '',
    Id: playlist.id,
    Payload: playlist,
    SortName: playlist.name ?? '',
});

// Determine whether a list-query can be served from the local cache. The
// Dexie `playlists` table is indexed by `SortName`, so we can serve queries
// that sort by NAME ASC with no server-side filters. Anything else (smart-
// playlist exclusion, search terms, alternative sorts) must go to network.
const canServeListFromCache = (query: PlaylistListQuery): boolean => {
    if (query.searchTerm) return false;
    if (query.excludeSmartPlaylists) return false;
    if (query._custom && Object.keys(query._custom).length > 0) return false;
    if (query.sortBy !== undefined && query.sortBy !== PlaylistListSort.NAME) return false;
    if (query.sortOrder !== undefined && query.sortOrder !== SortOrder.ASC) return false;
    return true;
};

// ---------------------------------------------------------------------------
// List — non-suspense
// ---------------------------------------------------------------------------

export const usePlaylistListQuery = (args: PlaylistListQueryArgs) => {
    const { options, query, serverId } = args;

    return useCachedQuery<PlaylistListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.playlists.bulkPut(items.map(toCachedPlaylistRow));
            markSearchDirty('playlists');
        },
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db) => {
            if (!canServeListFromCache(query)) return undefined;
            const rows = await db.playlists.orderBy('SortName').toArray();
            if (rows.length === 0) return undefined;
            return {
                items: rows.map((r) => r.Payload),
                startIndex: 0,
                totalRecordCount: rows.length,
            };
        },
        queryKey: queryKeys.playlists.list(serverId ?? '', query),
        remote: (ctx) =>
            controller.getPlaylistList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<PlaylistListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// List — suspense
// ---------------------------------------------------------------------------

export const usePlaylistListSuspenseQuery = (args: PlaylistListSuspenseQueryArgs) => {
    const { options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey = queryKeyOverride ?? queryKeys.playlists.list(serverId ?? '', query);

    return useSuspenseQuery<PlaylistListResponse>({
        initialData: () => readSnapshot<PlaylistListResponse>(queryKey),
        initialDataUpdatedAt: 0,
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db && canServeListFromCache(query)) {
                try {
                    const rows = await db.playlists.orderBy('SortName').toArray();
                    if (rows.length > 0) {
                        writeSnapshot(queryKey, {
                            items: rows.map((r) => r.Payload),
                            startIndex: 0,
                            totalRecordCount: rows.length,
                        });
                    }
                } catch (err) {
                    console.warn('[cache] playlists list fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getPlaylistList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            })) as PlaylistListResponse;

            if (db) {
                try {
                    const items = fresh?.items ?? [];
                    if (items.length > 0) {
                        await db.playlists.bulkPut(items.map(toCachedPlaylistRow));
                        markSearchDirty('playlists');
                    }
                } catch (err) {
                    console.warn('[cache] playlists list apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Detail — non-suspense
// ---------------------------------------------------------------------------

export const usePlaylistDetailQuery = (args: PlaylistDetailQueryArgs) => {
    const { options, query, serverId } = args;
    const queryKey = queryKeys.playlists.detail(serverId ?? '', query.id, query);
    const callerPlaceholder = options?.placeholderData;

    // Caller-provided `placeholderData` (e.g. the song-list header seeding
    // from React Router `location.state.item`) overrides the IDB snapshot.
    // If absent, fall back to the cache snapshot like `useCachedQuery`
    // would have done internally. Either way we run a single `useQuery`
    // here to stay rules-of-hooks-safe across renders.
    return useQuery<PlaylistDetailResponse>({
        enabled: options?.enabled ?? Boolean(serverId),
        placeholderData: (() => {
            if (callerPlaceholder !== undefined) return callerPlaceholder;
            return readSnapshot<PlaylistDetailResponse>(queryKey);
        }) as never,
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db) {
                try {
                    const row = await db.playlists.get(query.id);
                    if (row?.Payload !== undefined) {
                        writeSnapshot(queryKey, row.Payload);
                    }
                } catch (err) {
                    console.warn('[cache] playlist detail fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getPlaylistDetail({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            })) as PlaylistDetailResponse;

            if (db && fresh) {
                try {
                    await db.playlists.put(toCachedPlaylistRow(fresh));
                    markSearchDirty('playlists');
                } catch (err) {
                    console.warn('[cache] playlist detail apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Detail — suspense
// ---------------------------------------------------------------------------

export const usePlaylistDetailSuspenseQuery = (args: PlaylistDetailSuspenseQueryArgs) => {
    const { options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey =
        queryKeyOverride ?? queryKeys.playlists.detail(serverId ?? '', query.id, query);

    return useSuspenseQuery<PlaylistDetailResponse>({
        initialData: () => {
            if (options?.placeholderData !== undefined) return options.placeholderData;
            return readSnapshot<PlaylistDetailResponse>(queryKey);
        },
        initialDataUpdatedAt: 0,
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            if (db) {
                try {
                    const row = await db.playlists.get(query.id);
                    if (row?.Payload !== undefined) {
                        writeSnapshot(queryKey, row.Payload);
                    }
                } catch (err) {
                    console.warn('[cache] playlist detail fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getPlaylistDetail({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            })) as PlaylistDetailResponse;

            if (db && fresh) {
                try {
                    await db.playlists.put(toCachedPlaylistRow(fresh));
                    markSearchDirty('playlists');
                } catch (err) {
                    console.warn('[cache] playlist detail apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Song list — non-suspense
// ---------------------------------------------------------------------------

const replacePlaylistSongs = async (
    db: ReturnType<typeof getActiveCacheDb>,
    playlistId: string,
    fresh: PlaylistSongListResponse | undefined,
) => {
    if (!db) return;
    await db.transaction('rw', db.playlistSongs, async () => {
        await db.playlistSongs.where('PlaylistId').equals(playlistId).delete();
        const now = nowMs();
        const items = fresh?.items ?? [];
        if (items.length === 0) return;
        await db.playlistSongs.bulkPut(
            items.map((song, index) => ({
                __cachedAt: now,
                ListOrder: index,
                PlaylistId: playlistId,
                SongId: song.id,
                SongPayload: song,
            })),
        );
    });
};

export const usePlaylistSongListQuery = (args: PlaylistSongListQueryArgs) => {
    const { options, playlistId, query, serverId } = args;
    const fullQuery: PlaylistSongListQuery = { id: playlistId, ...(query ?? {}) };

    return useCachedQuery<PlaylistSongListResponse>({
        apply: async (db, fresh) => {
            await replacePlaylistSongs(db, playlistId, fresh);
        },
        enabled: options?.enabled ?? Boolean(serverId && playlistId),
        fromCache: async (db) => {
            const rows = await db.playlistSongs
                .where('PlaylistId')
                .equals(playlistId)
                .sortBy('ListOrder');
            if (rows.length === 0) return undefined;
            return {
                items: rows.map((r) => r.SongPayload),
                startIndex: 0,
                totalRecordCount: rows.length,
            };
        },
        queryKey: queryKeys.playlists.songList(serverId ?? '', playlistId),
        remote: (ctx) =>
            controller.getPlaylistSongList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: fullQuery,
            }) as Promise<PlaylistSongListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Song list — suspense
// ---------------------------------------------------------------------------

// Tracks per-queryKey background refetches so a cache-fast-path return
// doesn't fire multiple parallel network calls when the user navigates
// in/out of a playlist quickly.
const inFlightSongListRefetch = new Set<string>();

export const usePlaylistSongListSuspenseQuery = (args: PlaylistSongListSuspenseQueryArgs) => {
    const { options, playlistId, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey = queryKeyOverride ?? queryKeys.playlists.songList(serverId ?? '', playlistId);
    const fullQuery: PlaylistSongListQuery = { id: playlistId, ...(query ?? {}) };

    return useSuspenseQuery<PlaylistSongListResponse>({
        initialData: () => readSnapshot<PlaylistSongListResponse>(queryKey),
        initialDataUpdatedAt: 0,
        queryFn: async (ctx) => {
            const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;

            // Cache-fast-path: if Dexie has the songs, return them
            // immediately so the suspense boundary resolves on the first
            // frame. The fresh network call runs in the background and
            // updates the query cache + Dexie + snapshot map when it
            // lands — but the user sees the tracklist instantly. This is
            // the fix for the "playlist page renders but the song list
            // takes forever / never lands" symptom on large playlists.
            if (db) {
                try {
                    const rows = await db.playlistSongs
                        .where('PlaylistId')
                        .equals(playlistId)
                        .sortBy('ListOrder');
                    if (rows.length > 0) {
                        const cached: PlaylistSongListResponse = {
                            items: rows.map((r) => r.SongPayload),
                            startIndex: 0,
                            totalRecordCount: rows.length,
                        };
                        writeSnapshot(queryKey, cached);
                        const flightKey = JSON.stringify(queryKey);
                        if (!inFlightSongListRefetch.has(flightKey)) {
                            inFlightSongListRefetch.add(flightKey);
                            void (async () => {
                                try {
                                    const fresh = (await controller.getPlaylistSongList({
                                        apiClientProps: { serverId: serverId ?? '' },
                                        query: fullQuery,
                                    })) as PlaylistSongListResponse;
                                    try {
                                        await replacePlaylistSongs(db, playlistId, fresh);
                                    } catch (err) {
                                        console.warn(
                                            '[cache] playlist songs apply (bg) failed',
                                            queryKey,
                                            err,
                                        );
                                    }
                                    writeSnapshot(queryKey, fresh);
                                    queryClient.setQueryData(queryKey, fresh);
                                } catch (err) {
                                    console.warn(
                                        '[cache] playlist songs revalidate (bg) failed',
                                        queryKey,
                                        err,
                                    );
                                } finally {
                                    inFlightSongListRefetch.delete(flightKey);
                                }
                            })();
                        }
                        return cached;
                    }
                } catch (err) {
                    console.warn('[cache] playlist songs fromCache failed', queryKey, err);
                }
            }

            const fresh = (await controller.getPlaylistSongList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: fullQuery,
            })) as PlaylistSongListResponse;

            if (db) {
                try {
                    await replacePlaylistSongs(db, playlistId, fresh);
                } catch (err) {
                    console.warn('[cache] playlist songs apply failed', queryKey, err);
                }
            }

            writeSnapshot(queryKey, fresh);
            return fresh;
        },
        queryKey,
        staleTime: options?.staleTime,
    });
};
