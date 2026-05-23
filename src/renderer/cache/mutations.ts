// Durable optimistic mutation queue for the local-first cache.
//
// All writes to the server go through enqueueMutation(): we apply an
// optimistic patch to the Dexie cache, persist a queued row so the work
// survives reloads, and then drain the queue in FIFO order with retry and
// rollback. The store's pendingMutations counter is kept in sync so the UI
// can render a "saving..." indicator.

import { nanoid } from 'nanoid/non-secure';

import type { LibraryCacheDb } from './db';
import type {
    CachedFavorite,
    CachedFavoriteKind,
    CachedPlaylist,
    CachedPlaylistSong,
    MutationOp,
    MutationRow,
} from './types';

import { getActiveCacheDb } from './db';
import { useCacheStore } from './store';

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { queryClient } from '/@/renderer/lib/react-query';
import { useAuthStore } from '/@/renderer/store';
import { toast } from '/@/shared/components/toast/toast';
import {
    AddToPlaylistArgs,
    CreatePlaylistArgs,
    DeletePlaylistArgs,
    FavoriteArgs,
    LibraryItem,
    MoveItemArgs,
    RemoveFromPlaylistArgs,
    ScrobbleArgs,
    SetRatingArgs,
    UpdatePlaylistArgs,
} from '/@/shared/types/domain-types';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const safeStringify = (value: unknown): string => {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
};

export const idempotencyKey = (op: MutationOp, args: unknown, userId: string): string =>
    `${op}:${userId}:${safeStringify(args)}`;

export const backoffMs = (attempts: number): number => Math.min(30_000, 1_000 * 2 ** attempts);

const httpStatusOf = (err: unknown): number | undefined => {
    if (err && typeof err === 'object') {
        const e = err as { response?: { status?: number }; status?: number };
        return e.response?.status ?? e.status;
    }
    return undefined;
};

export const isRetryable = (err: unknown): boolean => {
    const status = httpStatusOf(err);
    if (status === undefined) {
        // No response = network/transport error, worth retrying.
        return true;
    }
    if (status === 408 || status === 429) {
        return true;
    }
    if (status >= 500) {
        return true;
    }
    return false;
};

export const isConflict = (err: unknown): boolean => httpStatusOf(err) === 409;

const setPendingCount = async (): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) {
        useCacheStore.getState().actions.setPendingMutations(0);
        return;
    }
    const n = await db.mutationQueue.where('status').notEqual('failed').count();
    useCacheStore.getState().actions.setPendingMutations(n);
};

const cachedKindFromLibraryItem = (
    type: LibraryItem | string | undefined,
): CachedFavoriteKind | undefined => {
    switch (type) {
        case LibraryItem.ALBUM:
            return 'Album';
        case LibraryItem.ALBUM_ARTIST:
            return 'AlbumArtist';
        case LibraryItem.ARTIST:
            return 'Artist';
        case LibraryItem.PLAYLIST:
            return 'Playlist';
        case LibraryItem.PLAYLIST_SONG:
        case LibraryItem.QUEUE_SONG:
        case LibraryItem.SONG:
            return 'Song';
        default:
            return undefined;
    }
};

// ---------------------------------------------------------------------------
// Snapshot shapes — discriminated unions so rollback can restore both
// "row existed" and "row didn't exist" cases cleanly.
// ---------------------------------------------------------------------------

type FavoriteRowSnapshot =
    | { key: [string, string]; kind: 'delete' }
    | { kind: 'restore'; row: CachedFavorite };

interface FavoriteSnapshot {
    rows: FavoriteRowSnapshot[];
}

interface OpHandler<TArgs, TSnapshot> {
    apply: (db: LibraryCacheDb, args: TArgs) => Promise<TSnapshot>;
    invalidate: (args: TArgs) => void;
    remote: (args: TArgs) => Promise<unknown>;
    rollback: (db: LibraryCacheDb, snapshot: TSnapshot) => Promise<void>;
}

interface PlaylistRowSnapshot {
    delete: boolean;
    previous: CachedPlaylist | undefined;
    songs?: CachedPlaylistSong[];
}

interface PlaylistSongsSnapshot {
    playlistId: string;
    previous: CachedPlaylistSong[];
}

// All op handlers accept the existing controller-style args (e.g.
// FavoriteArgs, SetRatingArgs). The queue stores them as `unknown` and we
// type-narrow inside each handler — callers MUST hand in the matching
// shape for the op they're enqueueing.

// ---------------------------------------------------------------------------
// Favorite helpers
// ---------------------------------------------------------------------------

const favoriteIds = (args: FavoriteArgs): string[] =>
    Array.isArray(args.query.id) ? args.query.id : [args.query.id];

const applyFavorite = async (
    db: LibraryCacheDb,
    args: FavoriteArgs,
    nextValue: boolean,
): Promise<FavoriteSnapshot> => {
    const kind = cachedKindFromLibraryItem(args.query.type);
    const rows: FavoriteRowSnapshot[] = [];
    if (!kind) {
        return { rows };
    }
    const ids = favoriteIds(args);
    const now = Date.now();

    for (const id of ids) {
        const key: [string, string] = [id, kind];
        const prev = await db.favorites.get(key);
        if (prev) {
            rows.push({ kind: 'restore', row: prev });
            await db.favorites.put({ ...prev, __cachedAt: now, IsFavorite: nextValue });
        } else {
            rows.push({ key, kind: 'delete' });
            await db.favorites.put({
                __cachedAt: now,
                IsFavorite: nextValue,
                ItemId: id,
                ItemType: kind,
                LastPlayedDate: undefined,
                PlayCount: 0,
                Rating: undefined,
            });
        }
    }

    return { rows };
};

const rollbackFavorite = async (db: LibraryCacheDb, snapshot: FavoriteSnapshot): Promise<void> => {
    for (const entry of snapshot.rows) {
        if (entry.kind === 'restore') {
            await db.favorites.put(entry.row);
        } else {
            await db.favorites.delete(entry.key);
        }
    }
};

const invalidateFavoriteScopes = (args: FavoriteArgs): void => {
    const serverId = args.apiClientProps.serverId;
    const ids = favoriteIds(args);
    switch (args.query.type) {
        case LibraryItem.ALBUM: {
            queryClient.invalidateQueries({
                exact: false,
                queryKey: queryKeys.albums.root(serverId),
            });
            break;
        }
        case LibraryItem.ALBUM_ARTIST:
        case LibraryItem.ARTIST: {
            queryClient.invalidateQueries({
                exact: false,
                queryKey: queryKeys.albumArtists.root(serverId),
            });
            queryClient.invalidateQueries({
                exact: false,
                queryKey: queryKeys.artists.root(serverId),
            });
            break;
        }
        case LibraryItem.PLAYLIST: {
            queryClient.invalidateQueries({
                exact: false,
                queryKey: queryKeys.playlists.root(serverId),
            });
            break;
        }
        case LibraryItem.PLAYLIST_SONG:
        case LibraryItem.QUEUE_SONG:
        case LibraryItem.SONG: {
            queryClient.invalidateQueries({
                exact: false,
                queryKey: queryKeys.songs.root(serverId),
            });
            queryClient.invalidateQueries({
                exact: false,
                queryKey: queryKeys.albumArtists.favoriteSongs(serverId),
            });
            break;
        }
        default:
            break;
    }
    // Also invalidate per-ID detail queries so any open detail screen refreshes.
    for (const id of ids) {
        switch (args.query.type) {
            case LibraryItem.ALBUM:
                queryClient.invalidateQueries({
                    exact: false,
                    queryKey: queryKeys.albums.detail(serverId, { id }),
                });
                break;
            case LibraryItem.ALBUM_ARTIST:
            case LibraryItem.ARTIST:
                queryClient.invalidateQueries({
                    exact: false,
                    queryKey: queryKeys.albumArtists.detail(serverId, { id }),
                });
                break;
            case LibraryItem.PLAYLIST:
                queryClient.invalidateQueries({
                    exact: false,
                    queryKey: queryKeys.playlists.detail(serverId, id),
                });
                break;
            case LibraryItem.PLAYLIST_SONG:
            case LibraryItem.QUEUE_SONG:
            case LibraryItem.SONG:
                queryClient.invalidateQueries({
                    exact: false,
                    queryKey: queryKeys.songs.detail(serverId, { id }),
                });
                break;
            default:
                break;
        }
    }
};

// ---------------------------------------------------------------------------
// Playlist helpers
// ---------------------------------------------------------------------------

const snapshotPlaylistSongs = async (
    db: LibraryCacheDb,
    playlistId: string,
): Promise<PlaylistSongsSnapshot> => {
    const previous = await db.playlistSongs
        .where('PlaylistId')
        .equals(playlistId)
        .sortBy('ListOrder');
    return { playlistId, previous };
};

const restorePlaylistSongs = async (
    db: LibraryCacheDb,
    snapshot: PlaylistSongsSnapshot,
): Promise<void> => {
    const current = await db.playlistSongs
        .where('PlaylistId')
        .equals(snapshot.playlistId)
        .toArray();
    await db.playlistSongs.bulkDelete(
        current.map((row) => [row.PlaylistId, row.ListOrder] as [string, number]),
    );
    if (snapshot.previous.length > 0) {
        await db.playlistSongs.bulkPut(snapshot.previous);
    }
};

const invalidatePlaylistScopes = (serverId: string, playlistId?: string): void => {
    queryClient.invalidateQueries({
        exact: false,
        queryKey: queryKeys.playlists.root(serverId),
    });
    if (playlistId) {
        queryClient.invalidateQueries({
            exact: false,
            queryKey: queryKeys.playlists.detail(serverId, playlistId),
        });
        queryClient.invalidateQueries({
            exact: false,
            queryKey: queryKeys.playlists.songList(serverId, playlistId),
        });
    }
};

// ---------------------------------------------------------------------------
// Op handlers
// ---------------------------------------------------------------------------

const createFavoriteHandler: OpHandler<FavoriteArgs, FavoriteSnapshot> = {
    apply: (db, args) => applyFavorite(db, args, true),
    invalidate: invalidateFavoriteScopes,
    remote: (args) => controller.createFavorite(args as any),
    rollback: rollbackFavorite,
};

const deleteFavoriteHandler: OpHandler<FavoriteArgs, FavoriteSnapshot> = {
    apply: (db, args) => applyFavorite(db, args, false),
    invalidate: invalidateFavoriteScopes,
    remote: (args) => controller.deleteFavorite(args as any),
    rollback: rollbackFavorite,
};

const setRatingHandler: OpHandler<SetRatingArgs, FavoriteSnapshot> = {
    apply: async (db, args) => {
        const kind = cachedKindFromLibraryItem(args.query.type);
        const rows: FavoriteRowSnapshot[] = [];
        if (!kind) {
            return { rows };
        }
        const ids = Array.isArray(args.query.id) ? args.query.id : [args.query.id];
        const now = Date.now();

        for (const id of ids) {
            const key: [string, string] = [id, kind];
            const prev = await db.favorites.get(key);
            if (prev) {
                rows.push({ kind: 'restore', row: prev });
                await db.favorites.put({
                    ...prev,
                    __cachedAt: now,
                    Rating: args.query.rating > 0 ? args.query.rating : undefined,
                });
            } else {
                rows.push({ key, kind: 'delete' });
                await db.favorites.put({
                    __cachedAt: now,
                    IsFavorite: false,
                    ItemId: id,
                    ItemType: kind,
                    LastPlayedDate: undefined,
                    PlayCount: 0,
                    Rating: args.query.rating > 0 ? args.query.rating : undefined,
                });
            }
        }

        return { rows };
    },
    invalidate: (args) => {
        // SetRatingArgs has the same shape as FavoriteArgs for the scopes we care about.
        invalidateFavoriteScopes(args as unknown as FavoriteArgs);
    },
    remote: (args) => {
        const fn = controller.setRating;
        if (!fn) {
            throw new Error('setRating is not supported by the active server');
        }
        return fn(args as any);
    },
    rollback: rollbackFavorite,
};

const incrementPlayCountHandler: OpHandler<ScrobbleArgs, FavoriteSnapshot> = {
    apply: async (db, args) => {
        const rows: FavoriteRowSnapshot[] = [];
        const id = args.query.id;
        const key: [string, string] = [id, 'Song'];
        const prev = await db.favorites.get(key);
        const now = Date.now();
        if (prev) {
            rows.push({ kind: 'restore', row: prev });
            await db.favorites.put({
                ...prev,
                __cachedAt: now,
                LastPlayedDate: new Date().toISOString(),
                PlayCount: (prev.PlayCount ?? 0) + 1,
            });
        } else {
            rows.push({ key, kind: 'delete' });
            await db.favorites.put({
                __cachedAt: now,
                IsFavorite: false,
                ItemId: id,
                ItemType: 'Song',
                LastPlayedDate: new Date().toISOString(),
                PlayCount: 1,
                Rating: undefined,
            });
        }
        // Bug 5 — we deliberately do NOT bump `db.songs[id].Payload.playCount`
        // here. The `rollback` (shared with the favorites handlers) only knows
        // how to restore favorite rows; if we also mutated the song row and
        // the remote later hard-failed, the song's playCount/lastPlayedAt
        // would stay incremented while the favorite row got rolled back. The
        // next conflict refetch or scheduled sweep will reconcile the song
        // row from the server anyway, so skipping the optimistic song bump
        // is correct and avoids divergent state.
        console.info('[mutations] incrementPlayCount applied (favorites-only optimistic)', { id });
        return { rows };
    },
    invalidate: (args) => {
        const serverId = args.apiClientProps.serverId;
        queryClient.invalidateQueries({ exact: false, queryKey: queryKeys.songs.root(serverId) });
    },
    remote: (args) => controller.scrobble(args as any),
    rollback: rollbackFavorite,
};

const addToPlaylistHandler: OpHandler<AddToPlaylistArgs, PlaylistSongsSnapshot> = {
    apply: async (db, args) => {
        const playlistId = args.query.id;
        const snapshot = await snapshotPlaylistSongs(db, playlistId);
        const now = Date.now();
        let nextOrder =
            snapshot.previous.length > 0
                ? snapshot.previous[snapshot.previous.length - 1].ListOrder + 1
                : 0;
        const newRows: CachedPlaylistSong[] = [];
        for (const songId of args.body.songId) {
            const songRow = await db.songs.get(songId);
            if (!songRow) {
                continue;
            }
            newRows.push({
                __cachedAt: now,
                ListOrder: nextOrder++,
                PlaylistId: playlistId,
                SongId: songId,
                SongPayload: songRow.Payload,
            });
        }
        if (newRows.length > 0) {
            await db.playlistSongs.bulkPut(newRows);
        }
        return snapshot;
    },
    invalidate: (args) => invalidatePlaylistScopes(args.apiClientProps.serverId, args.query.id),
    remote: (args) => controller.addToPlaylist(args as any),
    rollback: restorePlaylistSongs,
};

const removeFromPlaylistHandler: OpHandler<RemoveFromPlaylistArgs, PlaylistSongsSnapshot> = {
    apply: async (db, args) => {
        const playlistId = args.query.id;
        const snapshot = await snapshotPlaylistSongs(db, playlistId);
        const removeSet = new Set(args.query.songId);
        const keep = snapshot.previous.filter((row) => !removeSet.has(row.SongId));
        // Recompute ListOrder densely so the indexes don't have gaps.
        const reindexed: CachedPlaylistSong[] = keep.map((row, idx) => ({
            ...row,
            ListOrder: idx,
        }));
        const toDelete = snapshot.previous.map(
            (row) => [row.PlaylistId, row.ListOrder] as [string, number],
        );
        await db.playlistSongs.bulkDelete(toDelete);
        if (reindexed.length > 0) {
            await db.playlistSongs.bulkPut(reindexed);
        }
        return snapshot;
    },
    invalidate: (args) => invalidatePlaylistScopes(args.apiClientProps.serverId, args.query.id),
    remote: (args) => controller.removeFromPlaylist(args as any),
    rollback: restorePlaylistSongs,
};

const reorderPlaylistHandler: OpHandler<MoveItemArgs, PlaylistSongsSnapshot> = {
    apply: async (db, args) => {
        const playlistId = args.query.playlistId;
        const snapshot = await snapshotPlaylistSongs(db, playlistId);
        const { endingIndex, startingIndex } = args.query;
        if (
            startingIndex < 0 ||
            endingIndex < 0 ||
            startingIndex >= snapshot.previous.length ||
            endingIndex >= snapshot.previous.length ||
            startingIndex === endingIndex
        ) {
            return snapshot;
        }
        const reordered = snapshot.previous.slice();
        const [moved] = reordered.splice(startingIndex, 1);
        reordered.splice(endingIndex, 0, moved);
        const reindexed: CachedPlaylistSong[] = reordered.map((row, idx) => ({
            ...row,
            __cachedAt: Date.now(),
            ListOrder: idx,
        }));
        const toDelete = snapshot.previous.map(
            (row) => [row.PlaylistId, row.ListOrder] as [string, number],
        );
        await db.playlistSongs.bulkDelete(toDelete);
        if (reindexed.length > 0) {
            await db.playlistSongs.bulkPut(reindexed);
        }
        return snapshot;
    },
    invalidate: (args) =>
        invalidatePlaylistScopes(args.apiClientProps.serverId, args.query.playlistId),
    remote: (args) => {
        const fn = controller.movePlaylistItem;
        if (!fn) {
            throw new Error('movePlaylistItem is not supported by the active server');
        }
        return fn(args as any);
    },
    rollback: restorePlaylistSongs,
};

const createPlaylistHandler: OpHandler<CreatePlaylistArgs, PlaylistRowSnapshot> = {
    apply: async (db, args) => {
        // We can't know the server-assigned id yet, so we don't optimistically
        // insert a row — that would surface a phantom row that disappears on
        // success. Instead, leave the cache as-is and rely on invalidate to
        // refresh the playlist list once the server responds.
        void db;
        void args;
        return { delete: false, previous: undefined };
    },
    invalidate: (args) => invalidatePlaylistScopes(args.apiClientProps.serverId),
    remote: (args) => controller.createPlaylist(args as any),
    rollback: async () => {
        // Nothing to undo since apply was a no-op.
    },
};

const renamePlaylistHandler: OpHandler<UpdatePlaylistArgs, PlaylistRowSnapshot> = {
    apply: async (db, args) => {
        const playlistId = args.query.id;
        const prev = await db.playlists.get(playlistId);
        if (!prev) {
            return { delete: false, previous: undefined };
        }
        const now = Date.now();
        await db.playlists.put({
            ...prev,
            __cachedAt: now,
            Payload: {
                ...prev.Payload,
                name: args.body.name,
            },
            SortName: args.body.name,
        });
        return { delete: false, previous: prev };
    },
    invalidate: (args) => invalidatePlaylistScopes(args.apiClientProps.serverId, args.query.id),
    remote: (args) => controller.updatePlaylist(args as any),
    rollback: async (db, snapshot) => {
        if (snapshot.previous) {
            await db.playlists.put(snapshot.previous);
        }
    },
};

const deletePlaylistHandler: OpHandler<DeletePlaylistArgs, PlaylistRowSnapshot> = {
    apply: async (db, args) => {
        const playlistId = args.query.id;
        const prev = await db.playlists.get(playlistId);
        const songs = await db.playlistSongs
            .where('PlaylistId')
            .equals(playlistId)
            .sortBy('ListOrder');
        if (prev) {
            await db.playlists.delete(playlistId);
        }
        if (songs.length > 0) {
            await db.playlistSongs.bulkDelete(
                songs.map((row) => [row.PlaylistId, row.ListOrder] as [string, number]),
            );
        }
        return { delete: true, previous: prev, songs };
    },
    invalidate: (args) => invalidatePlaylistScopes(args.apiClientProps.serverId, args.query.id),
    remote: (args) => controller.deletePlaylist(args as any),
    rollback: async (db, snapshot) => {
        if (snapshot.previous) {
            await db.playlists.put(snapshot.previous);
        }
        if (snapshot.songs && snapshot.songs.length > 0) {
            await db.playlistSongs.bulkPut(snapshot.songs);
        }
    },
};

// Cast through unknown — the queue stores args as `unknown` and we
// type-narrow at each handler boundary; the runtime contract is enforced
// by the caller passing the matching shape for the op.
const handlers: Record<MutationOp, OpHandler<any, any>> = {
    addToPlaylist: addToPlaylistHandler,
    createFavorite: createFavoriteHandler,
    createPlaylist: createPlaylistHandler,
    deleteFavorite: deleteFavoriteHandler,
    deletePlaylist: deletePlaylistHandler,
    incrementPlayCount: incrementPlayCountHandler,
    removeFromPlaylist: removeFromPlaylistHandler,
    renamePlaylist: renamePlaylistHandler,
    reorderPlaylist: reorderPlaylistHandler,
    setRating: setRatingHandler,
};

// ---------------------------------------------------------------------------
// Conflict resolution — refetch + patch the affected cache entries.
// ---------------------------------------------------------------------------

const refetchFavoriteEntity = async (
    db: LibraryCacheDb,
    args: FavoriteArgs | SetRatingArgs,
): Promise<void> => {
    const serverId = args.apiClientProps.serverId;
    const ids = Array.isArray(args.query.id) ? args.query.id : [args.query.id];
    const kind = cachedKindFromLibraryItem(args.query.type);
    if (!kind) {
        return;
    }

    for (const id of ids) {
        try {
            const now = Date.now();
            if (kind === 'Album') {
                const album = await controller.getAlbumDetail({
                    apiClientProps: { serverId },
                    query: { id },
                });
                if (album) {
                    await db.favorites.put({
                        __cachedAt: now,
                        IsFavorite: album.userFavorite,
                        ItemId: id,
                        ItemType: 'Album',
                        LastPlayedDate: album.lastPlayedAt ?? undefined,
                        PlayCount: album.playCount ?? 0,
                        Rating: album.userRating ?? undefined,
                    });
                    const cached = await db.albums.get(id);
                    if (cached) {
                        await db.albums.put({ ...cached, __cachedAt: now, Payload: album });
                    }
                }
            } else if (kind === 'AlbumArtist' || kind === 'Artist') {
                const artist = await controller.getAlbumArtistDetail({
                    apiClientProps: { serverId },
                    query: { id },
                });
                if (artist) {
                    await db.favorites.put({
                        __cachedAt: now,
                        IsFavorite: artist.userFavorite,
                        ItemId: id,
                        ItemType: kind,
                        LastPlayedDate: artist.lastPlayedAt ?? undefined,
                        PlayCount: artist.playCount ?? 0,
                        Rating: artist.userRating ?? undefined,
                    });
                    const cached = await db.artists.get(id);
                    if (cached) {
                        await db.artists.put({ ...cached, __cachedAt: now, Payload: artist });
                    }
                }
            } else if (kind === 'Song') {
                const song = await controller.getSongDetail({
                    apiClientProps: { serverId },
                    query: { id },
                });
                if (song) {
                    await db.favorites.put({
                        __cachedAt: now,
                        IsFavorite: song.userFavorite,
                        ItemId: id,
                        ItemType: 'Song',
                        LastPlayedDate: song.lastPlayedAt ?? undefined,
                        PlayCount: song.playCount ?? 0,
                        Rating: song.userRating ?? undefined,
                    });
                    const cached = await db.songs.get(id);
                    if (cached) {
                        await db.songs.put({ ...cached, __cachedAt: now, Payload: song });
                    }
                }
            } else if (kind === 'Playlist') {
                const playlist = await controller.getPlaylistDetail({
                    apiClientProps: { serverId },
                    query: { id },
                });
                if (playlist) {
                    await db.playlists.put({
                        __cachedAt: now,
                        DateLastSaved: '',
                        Id: id,
                        Payload: playlist,
                        SortName: playlist.name,
                    });
                }
            }
        } catch (refetchErr) {
            console.error('[mutations] 409 refetch failed', {
                error: String(refetchErr),
                id,
                kind,
            });
        }
    }
};

const refetchPlaylistEntity = async (
    db: LibraryCacheDb,
    serverId: string,
    playlistId: string,
): Promise<void> => {
    try {
        const playlist = await controller.getPlaylistDetail({
            apiClientProps: { serverId },
            query: { id: playlistId },
        });
        const now = Date.now();
        if (playlist) {
            await db.playlists.put({
                __cachedAt: now,
                DateLastSaved: '',
                Id: playlistId,
                Payload: playlist,
                SortName: playlist.name,
            });
        } else {
            // Server says it's gone — remove our cached row.
            await db.playlists.delete(playlistId);
        }
    } catch (err) {
        console.error('[mutations] 409 playlist detail refetch failed', {
            error: String(err),
            playlistId,
        });
    }

    try {
        const result = await controller.getPlaylistSongList({
            apiClientProps: { serverId },
            query: { id: playlistId, limit: 5000, startIndex: 0 },
        });
        const fresh: CachedPlaylistSong[] = (result?.items ?? []).map((song, idx) => ({
            __cachedAt: Date.now(),
            ListOrder: idx,
            PlaylistId: playlistId,
            SongId: song.id,
            SongPayload: song,
        }));
        // Wipe current rows for this playlist, then write the fresh slice.
        const current = await db.playlistSongs.where('PlaylistId').equals(playlistId).toArray();
        await db.playlistSongs.bulkDelete(
            current.map((row) => [row.PlaylistId, row.ListOrder] as [string, number]),
        );
        if (fresh.length > 0) {
            await db.playlistSongs.bulkPut(fresh);
        }
    } catch (err) {
        console.error('[mutations] 409 playlist songs refetch failed', {
            error: String(err),
            playlistId,
        });
    }
};

const handleConflict = async (db: LibraryCacheDb, op: MutationOp, args: unknown): Promise<void> => {
    try {
        switch (op) {
            case 'addToPlaylist':
            case 'removeFromPlaylist': {
                const a = args as AddToPlaylistArgs | RemoveFromPlaylistArgs;
                await refetchPlaylistEntity(db, a.apiClientProps.serverId, a.query.id);
                break;
            }
            case 'createFavorite':
            case 'deleteFavorite':
            case 'incrementPlayCount':
            case 'setRating': {
                if (op === 'incrementPlayCount') {
                    const a = args as ScrobbleArgs;
                    // Treat the scrobbled item as a song for favorite-table purposes.
                    await refetchFavoriteEntity(db, {
                        apiClientProps: a.apiClientProps,
                        query: { id: [a.query.id], type: LibraryItem.SONG },
                    } as FavoriteArgs);
                } else {
                    await refetchFavoriteEntity(db, args as FavoriteArgs | SetRatingArgs);
                }
                break;
            }
            case 'createPlaylist': {
                // No specific id to refetch — invalidate alone is enough.
                break;
            }
            case 'deletePlaylist':
            case 'renamePlaylist': {
                const a = args as DeletePlaylistArgs | UpdatePlaylistArgs;
                await refetchPlaylistEntity(db, a.apiClientProps.serverId, a.query.id);
                break;
            }
            case 'reorderPlaylist': {
                const a = args as MoveItemArgs;
                await refetchPlaylistEntity(db, a.apiClientProps.serverId, a.query.playlistId);
                break;
            }
            default:
                break;
        }
    } catch (err) {
        console.error('[mutations] conflict refetch failed', { error: String(err), op });
    }

    // Backstop: also invalidate so any visible react-query view re-pulls.
    try {
        const handler = handlers[op];
        handler.invalidate(args);
    } catch (err) {
        console.error('[mutations] conflict invalidate failed', { error: String(err), op });
    }
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const enqueueMutation = async (op: MutationOp, args: unknown): Promise<void> => {
    const db = getActiveCacheDb();
    if (!db) {
        console.info('[mutations] no active db — calling remote directly', { op });
        await handlers[op].remote(args);
        return;
    }

    const userId = useAuthStore.getState().currentServer?.userId ?? '';
    const snapshot = await handlers[op].apply(db, args);

    const row: MutationRow = {
        args,
        attempts: 0,
        createdAt: Date.now(),
        id: nanoid(),
        idempotencyKey: idempotencyKey(op, args, userId),
        lastError: undefined,
        op,
        snapshot,
        status: 'pending',
    };

    await db.mutationQueue.put(row);
    handlers[op].invalidate(args);
    await setPendingCount();

    console.info('[mutations] enqueued', {
        id: row.id,
        idempotencyKey: row.idempotencyKey,
        op,
    });

    void startWorker();
};

let workerRunning = false;

export const startWorker = async (): Promise<void> => {
    if (workerRunning) {
        return;
    }
    workerRunning = true;
    try {
        // Bug 4 — recover any rows stuck in `in_progress` from a previous
        // session that crashed between `update(id, { status: 'in_progress' })`
        // and the success/failure branch. Without this, those rows are
        // silently skipped forever because the drain loop only picks
        // `status === 'pending'`. Requeue them so the loop below grabs them
        // via the normal pending path.
        {
            const db = getActiveCacheDb();
            if (db) {
                const orphaned = await db.mutationQueue
                    .where('status')
                    .equals('in_progress')
                    .toArray();
                if (orphaned.length > 0) {
                    console.info('[mutations] requeuing orphaned in-progress rows', {
                        count: orphaned.length,
                    });
                    await db.mutationQueue.bulkPut(
                        orphaned.map((row) => ({ ...row, status: 'pending' as const })),
                    );
                }
            }
        }

        for (;;) {
            const db = getActiveCacheDb();
            if (!db) {
                console.info(
                    '[mutations] worker stopping — no active cache DB (subsystem disabled or server switched)',
                );
                break;
            }

            // FIFO over pending rows.
            const next = await db.mutationQueue
                .where('status')
                .equals('pending')
                .sortBy('createdAt')
                .then((rows) => rows[0]);

            if (!next) {
                break;
            }

            const attempt = next.attempts + 1;
            await db.mutationQueue.update(next.id, { status: 'in_progress' });
            console.info('[mutations] running', { attempt, id: next.id, op: next.op });

            try {
                await handlers[next.op].remote(next.args);
                await db.mutationQueue.delete(next.id);
                console.info('[mutations] success', { id: next.id, op: next.op });
            } catch (err) {
                if (isConflict(err)) {
                    console.warn('[mutations] conflict — refetching and dropping queue row', {
                        error: String(err),
                        id: next.id,
                        op: next.op,
                    });
                    await db.mutationQueue.delete(next.id);
                    await handleConflict(db, next.op, next.args);
                } else if (isRetryable(err)) {
                    const attempts = next.attempts + 1;
                    console.warn('[mutations] retryable error', {
                        attempts,
                        error: String(err),
                        id: next.id,
                        op: next.op,
                    });
                    await db.mutationQueue.update(next.id, {
                        attempts,
                        lastError: String(err),
                        status: 'pending',
                    });
                    await sleep(backoffMs(attempts));
                } else {
                    console.error('[mutations] hard failure — rolling back', {
                        error: String(err),
                        id: next.id,
                        op: next.op,
                    });
                    try {
                        await handlers[next.op].rollback(db, next.snapshot);
                    } catch (rbErr) {
                        console.error('[mutations] rollback failed', {
                            error: String(rbErr),
                            id: next.id,
                            op: next.op,
                        });
                    }
                    await db.mutationQueue.update(next.id, {
                        lastError: String(err),
                        status: 'failed',
                    });
                    try {
                        handlers[next.op].invalidate(next.args);
                    } catch (invErr) {
                        console.error('[mutations] post-failure invalidate failed', {
                            error: String(invErr),
                            id: next.id,
                            op: next.op,
                        });
                    }
                    toast.error({
                        message: `Couldn't save your change (${next.op}). It has been rolled back.`,
                    });
                }
            }

            await setPendingCount();
        }
    } finally {
        workerRunning = false;
    }
    await setPendingCount();
};

// React hook that subscribes the consumer to the live pending count.
export const useMutationQueueCount = (): number => useCacheStore((s) => s.pendingMutations);

// Test/internal helper to recompute the pending count on demand.
export const refreshPendingMutationCount = setPendingCount;
