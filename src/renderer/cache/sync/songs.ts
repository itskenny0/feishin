import type { LibraryCacheDb } from '../db';
import type { CachedSong } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { ServerListItem, SongListSort, SortOrder } from '/@/shared/types/domain-types';

const fetchSongsPage =
    (server: ServerListItem) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedSong[]; total: number }> => {
        const result = await controller.getSongList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: SongListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex,
            },
        });

        const now = Date.now();
        const items: CachedSong[] = (result?.items ?? []).map((song) => ({
            __cachedAt: now,
            AlbumArtistId: song.albumArtists[0]?.id,
            AlbumId: song.albumId,
            DateLastSaved: song.updatedAt,
            Id: song.id,
            IndexNumber: song.trackNumber,
            ParentIndexNumber: song.discNumber,
            Payload: song,
        }));

        return {
            items,
            total: result?.totalRecordCount ?? 0,
        };
    };

const writeSongsPage = async (db: LibraryCacheDb, items: CachedSong[]): Promise<void> => {
    await db.songs.bulkPut(items);
};

export const runSongsSweep = (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    console.info('[cache] sweep:songs dispatching with server', {
        baseUrl: server.url,
        serverId: server.id,
    });
    return runSweep<CachedSong>({
        ctx,
        fetchPage: fetchSongsPage(server),
        writePage: writeSongsPage,
    });
};
