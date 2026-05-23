import type { LibraryCacheDb } from '../db';
import type { CachedAlbum } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { AlbumListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const fetchAlbumsPage =
    (server: ServerListItem) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedAlbum[]; total: number }> => {
        const result = await controller.getAlbumList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: AlbumListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex,
            },
        });

        const now = Date.now();
        const items: CachedAlbum[] = (result?.items ?? []).map((album) => ({
            __cachedAt: now,
            AlbumArtistId: album.albumArtists[0]?.id ?? '',
            DateLastSaved: album.updatedAt,
            Id: album.id,
            Payload: album,
            ProductionYear: album.releaseYear ?? undefined,
            SortName: album.sortName,
        }));

        return {
            items,
            total: result?.totalRecordCount ?? 0,
        };
    };

const writeAlbumsPage = async (db: LibraryCacheDb, items: CachedAlbum[]): Promise<void> => {
    await db.albums.bulkPut(items);
};

export const runAlbumsSweep = (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    console.info('[cache] sweep:albums dispatching with server', {
        baseUrl: server.url,
        serverId: server.id,
    });
    return runSweep<CachedAlbum>({
        ctx,
        fetchPage: fetchAlbumsPage(server),
        writePage: writeAlbumsPage,
    });
};
