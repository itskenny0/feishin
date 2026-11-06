// Cached query hooks for the playlists feature.
//
// These wrap the controller calls with `useCachedQuery` (plus hand-rolled
// suspense variants) so the IndexedDB cache primes the snapshot map before
// the network round-trip lands. Same pattern as `genres-queries.ts`.
//
// Playlist sweeps prime `db.playlists` for the list query. The detail row
// is a single playlist payload (also reused from the list sweep). Playlist
// songs are write-through only — Jellyfin / Subsonic don't expose a bulk
// playlist-songs endpoint, so we cannot pre-hydrate, but once a user opens
// a playlist its songs land in `db.playlistSongs` and subsequent mounts
// paint instantly.

import type { QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { useQuery, useSuspenseQuery } from '@tanstack/react-query';

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    cachedSwr,
    filterPlaylistsLocal,
    getActiveCacheDb,
    LibraryCacheDb,
    markSearchDirty,
    prepareExplicitRefresh,
    readSnapshot,
    useCachedQuery,
} from '/@/renderer/cache';
import {
    Playlist,
    PlaylistDetailQuery,
    PlaylistDetailResponse,
    PlaylistListQuery,
    PlaylistListResponse,
    PlaylistSongListQuery,
    PlaylistSongListResponse,
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

interface PlaylistSongListSuspenseQueryArgs {
    options?: CachedQueryHookOptions;
    playlistId: string;
    query?: Omit<PlaylistSongListQuery, 'id'>;
    queryKey?: QueryKey;
    serverId: string | undefined;
}

const toCachedPlaylistRow = (playlist: Playlist) => ({
    __cachedAt: Date.now(),
    DateLastSaved: '',
    Id: playlist.id,
    Payload: playlist,
    SortName: playlist.name ?? '',
});

// ---------------------------------------------------------------------------
// List
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
            const rows = await db.playlists.toArray();
            if (rows.length === 0) return undefined;
            return filterPlaylistsLocal({ query, rows }) ?? undefined;
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
// Detail
// ---------------------------------------------------------------------------

const playlistDetailQueryFn =
    (query: PlaylistDetailQuery, queryKey: QueryKey, serverId: string | undefined) =>
    (ctx: QueryFunctionContext) =>
        cachedSwr<PlaylistDetailResponse>({
            apply: async (db, fresh) => {
                if (!fresh) return;
                await db.playlists.put(toCachedPlaylistRow(fresh));
                markSearchDirty('playlists');
            },
            ctx,
            fromCache: async (db) =>
                (await db.playlists.get(query.id))?.Payload as PlaylistDetailResponse | undefined,
            queryKey,
            remote: ({ signal }) =>
                controller.getPlaylistDetail({
                    apiClientProps: { serverId: serverId ?? '', signal },
                    query,
                }) as Promise<PlaylistDetailResponse>,
        });

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
        queryFn: playlistDetailQueryFn(query, queryKey, serverId),
        queryKey,
        staleTime: options?.staleTime,
    });
};

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
        queryFn: playlistDetailQueryFn(query, queryKey, serverId),
        queryKey,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Song list
// ---------------------------------------------------------------------------

const replacePlaylistSongs = async (
    db: LibraryCacheDb,
    playlistId: string,
    fresh: PlaylistSongListResponse | undefined,
) => {
    await db.transaction('rw', db.playlistSongs, async () => {
        await db.playlistSongs.where('PlaylistId').equals(playlistId).delete();
        const now = Date.now();
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

// Playlist edits call the server directly, so the cached copy goes stale.
// Drop the tracklist and open the refresh window, else sync-first keeps
// serving the pre-edit songs, name and count until the next sweep.
export const dropCachedPlaylistSongs = async (playlistId: string): Promise<void> => {
    prepareExplicitRefresh('playlists');
    try {
        await getActiveCacheDb()?.playlistSongs.where('PlaylistId').equals(playlistId).delete();
    } catch (err) {
        console.warn('[cache] playlists: drop songs failed', { id: playlistId }, err);
    }
};

export const usePlaylistSongListSuspenseQuery = (args: PlaylistSongListSuspenseQueryArgs) => {
    const { options, playlistId, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey = queryKeyOverride ?? queryKeys.playlists.songList(serverId ?? '', playlistId);
    const fullQuery: PlaylistSongListQuery = { id: playlistId, ...(query ?? {}) };

    // Cache-fast-path: if Dexie has the songs, return them immediately so
    // the suspense boundary resolves on the first frame. The fresh network
    // call runs in the background and updates the query cache + Dexie +
    // snapshot map when it lands — but the user sees the tracklist
    // instantly. This is the fix for the "playlist page renders but the
    // song list takes forever / never lands" symptom on large playlists.
    return useSuspenseQuery<PlaylistSongListResponse>({
        initialData: () => readSnapshot<PlaylistSongListResponse>(queryKey),
        initialDataUpdatedAt: 0,
        queryFn: (ctx) =>
            cachedSwr<PlaylistSongListResponse>({
                apply: async (db, fresh) => {
                    await replacePlaylistSongs(db, playlistId, fresh);
                    console.info('[cache] playlists: songList applied', {
                        id: playlistId,
                        songs: fresh?.items?.length ?? 0,
                    });
                },
                ctx,
                fromCache: async (db) => {
                    const rows = await db.playlistSongs
                        .where('PlaylistId')
                        .equals(playlistId)
                        .sortBy('ListOrder');
                    if (rows.length === 0) return undefined;
                    console.info('[cache] playlists: songList cache hit', {
                        id: playlistId,
                        songs: rows.length,
                    });
                    return {
                        items: rows.map((r) => r.SongPayload),
                        startIndex: 0,
                        totalRecordCount: rows.length,
                    };
                },
                queryKey,
                remote: (ctx) =>
                    controller.getPlaylistSongList({
                        apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                        query: fullQuery,
                    }) as Promise<PlaylistSongListResponse>,
            }),
        queryKey,
        staleTime: options?.staleTime,
    });
};
