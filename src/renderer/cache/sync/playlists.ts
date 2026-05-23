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
