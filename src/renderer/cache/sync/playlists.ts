import type { LibraryCacheDb } from '../db';
import type { CachedPlaylist } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { PlaylistListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const fetchPlaylistsPage =
    (server: ServerListItem) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedPlaylist[]; total: number }> => {
        const result = await controller.getPlaylistList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: PlaylistListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex,
            },
        });

        const now = Date.now();
        const items: CachedPlaylist[] = (result?.items ?? []).map((playlist) => ({
            __cachedAt: now,
            DateLastSaved: '',
            Id: playlist.id,
            Payload: playlist,
            SortName: playlist.name,
        }));

        return {
            items,
            total: result?.totalRecordCount ?? 0,
        };
    };

const writePlaylistsPage = async (db: LibraryCacheDb, items: CachedPlaylist[]): Promise<void> => {
    await db.playlists.bulkPut(items);
};

export const runPlaylistsSweep = (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    console.info('[cache] sweep:playlists dispatching with server', {
        baseUrl: server.url,
        serverId: server.id,
    });
    return runSweep<CachedPlaylist>({
        ctx,
        fetchPage: fetchPlaylistsPage(server),
        writePage: writePlaylistsPage,
    });
};

/**
 * Sync every playlist's SONG LIST into the `playlistSongs` sidecar.
 *
 * Without this, the sidecar only filled the first time a playlist's track
 * page loaded successfully ONLINE — a "synced" library still rendered a
 * never-opened playlist empty whenever the server was slow or unreachable
 * (device, 2026-06-10: a downloaded 100+-track playlist showed "no items").
 * Playlist counts are small (tens), so a sequential pass per hydration is
 * cheap relative to the song/album sweeps.
 */
export const runPlaylistSongsSweep = async (
    ctx: SweepContext,
    server: ServerListItem,
): Promise<void> => {
    const { db, signal } = ctx;
    const ids = (await db.playlists.toCollection().primaryKeys()) as string[];
    console.info('[cache] sweep:playlist-songs starting', { playlists: ids.length });
    let synced = 0;
    let failed = 0;
    for (const id of ids) {
        if (signal.aborted) return;
        try {
            const result = await controller.getPlaylistSongList({
                apiClientProps: { serverId: server.id, signal },
                query: { id },
            });
            const items = result?.items ?? [];
            const now = Date.now();
            await db.transaction('rw', db.playlistSongs, async () => {
                await db.playlistSongs.where('PlaylistId').equals(id).delete();
                if (items.length === 0) return;
                await db.playlistSongs.bulkPut(
                    items.map((song, index) => ({
                        __cachedAt: now,
                        ListOrder: index,
                        PlaylistId: id,
                        SongId: song.id,
                        SongPayload: song,
                    })),
                );
            });
            synced += 1;
        } catch (err) {
            if ((err as Error)?.name === 'AbortError') return;
            failed += 1;
            console.warn('[cache] sweep:playlist-songs failed', {
                error: (err as Error)?.message,
                id,
            });
        }
    }
    console.info('[cache] sweep:playlist-songs complete', { failed, synced });
};
