// Cached query hooks for the songs feature.
//
// These wrap `controller.getSongList` / `controller.getSongDetail` with
// `useCachedQuery` so the IndexedDB cache primes the snapshot map before
// the network round-trip lands. The radio / random / similar / queue
// endpoints are intentionally NOT migrated here -- they fetch
// non-deterministic or server-owned data where caching would defeat the
// caller's intent (auto-DJ wants fresh picks every play). Those continue
// to live on `songsQueries` as plain `queryOptions` consumed by raw
// `useQuery`.
//
// Mirrors the layout introduced for albums/artists -- the existing
// `songsQueries` object in `../api/songs-api.ts` stays intact so that
// in-flight consumers continue to work, and components migrate over to
// these hooks at their own pace.

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { filterSongsLocal, markSearchDirty, useCachedQuery } from '/@/renderer/cache';
import {
    Song,
    SongDetailQuery,
    SongDetailResponse,
    SongListQuery,
    SongListResponse,
} from '/@/shared/types/domain-types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

interface SongsQueryArgs<TQuery> {
    options?: CachedQueryHookOptions;
    query: TQuery;
    serverId: string | undefined;
}

const nowMs = () => Date.now();

// Project a Song payload into the row-shape expected by `db.songs`. Field
// names mirror `src/renderer/cache/types.ts:CachedSong`, with nullable
// domain fields coalesced to `undefined` because Dexie indexes treat
// missing better than null.
const songToRow = (song: Song) => ({
    __cachedAt: nowMs(),
    AlbumArtistId: song.albumArtists?.[0]?.id ?? undefined,
    AlbumId: song.albumId ?? undefined,
    DateLastSaved: song.updatedAt ?? '',
    Id: song.id,
    IndexNumber: song.trackNumber ?? undefined,
    ParentIndexNumber: song.discNumber ?? undefined,
    Payload: song,
});

// ---------------------------------------------------------------------------
// Song list (paginated)
// ---------------------------------------------------------------------------

interface SongListHookArgs {
    imageSize?: number;
    options?: CachedQueryHookOptions;
    query: SongListQuery;
    serverId: string | undefined;
}

// Server-only filters that can't be reproduced locally. When any of
// these is set the query falls through to the network.
const hasServerOnlySongFilter = (query: SongListQuery): boolean => {
    if (query.hasRating !== undefined) return true;
    if (query.minYear !== undefined || query.maxYear !== undefined) return true;
    if (query.musicFolderId) return true;
    if (query._custom && Object.keys(query._custom).length > 0) return true;
    return false;
};

export const useSongListQuery = (args: SongListHookArgs) => {
    const { imageSize, options, query, serverId } = args;
    const effectiveQuery = { ...query, imageSize };

    return useCachedQuery<SongListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.songs.bulkPut(items.map(songToRow));
            markSearchDirty('songs');
        },
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db) => {
            if (hasServerOnlySongFilter(query)) return undefined;

            // Prefer the cheapest Dexie pre-filter we can manage before
            // we have to scan. Single-album and single-album-artist both
            // map to indexed columns.
            let rows;
            if (query.albumIds?.length === 1) {
                rows = await db.songs.where('AlbumId').equals(query.albumIds[0]).toArray();
            } else if (query.albumArtistIds?.length === 1) {
                rows = await db.songs
                    .where('AlbumArtistId')
                    .equals(query.albumArtistIds[0])
                    .toArray();
            } else {
                rows = await db.songs.toArray();
            }
            if (rows.length === 0) return undefined;

            let favoriteSongIds: Set<string> | undefined;
            if (query.favorite !== undefined) {
                // `ItemType` is part of the compound primary key but not a
                // standalone index, so the previous .where('ItemType') form
                // threw a SchemaError that the outer try/catch swallowed.
                // .filter() does a table walk in JS — fine, the favorites
                // table is small by design.
                const favs = await db.favorites.filter((r) => r.ItemType === 'Song').toArray();
                favoriteSongIds = new Set(favs.filter((f) => f.IsFavorite).map((f) => f.ItemId));
            }

            return filterSongsLocal({
                favoriteSongIds,
                query,
                rows,
            });
        },
        queryKey: queryKeys.songs.list(serverId ?? '', effectiveQuery),
        remote: (ctx) =>
            controller.getSongList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: effectiveQuery,
            }) as Promise<SongListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Song detail
// ---------------------------------------------------------------------------

export const useSongDetailQuery = (args: SongsQueryArgs<SongDetailQuery>) => {
    const { options, query, serverId } = args;

    return useCachedQuery<SongDetailResponse>({
        apply: async (db, fresh) => {
            if (!fresh) return;
            await db.songs.put(songToRow(fresh));
            markSearchDirty('songs');
        },
        enabled: options?.enabled ?? Boolean(serverId && query?.id),
        fromCache: async (db) => {
            if (!query?.id) return undefined;
            const row = await db.songs.get(query.id);
            return row?.Payload ?? undefined;
        },
        queryKey: queryKeys.songs.detail(serverId ?? '', query),
        remote: (ctx) =>
            controller.getSongDetail({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<SongDetailResponse>,
        staleTime: options?.staleTime,
    });
};
