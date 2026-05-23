import type { LibraryCacheDb } from '../db';
import type { CachedAlbum } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { AlbumListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const DELTA_SAFETY_MS = 60_000;

const fetchAlbumsPage =
    (server: ServerListItem, deltaMode: boolean) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedAlbum[]; total: number }> => {
        const result = await controller.getAlbumList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: deltaMode ? AlbumListSort.RECENTLY_ADDED : AlbumListSort.NAME,
                sortOrder: deltaMode ? SortOrder.DESC : SortOrder.ASC,
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

const albumCreatedAtMs = (album: CachedAlbum): number | undefined => {
    const created = (album.Payload as { createdAt?: string }).createdAt;
    if (!created) return undefined;
    const ms = Date.parse(created);
    return Number.isFinite(ms) ? ms : undefined;
};

export const runAlbumsSweep = async (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    const meta = await ctx.db.syncMeta.get('albums');
    const deltaCutoffMs =
        meta?.lastFullSyncAt && meta.hydrationState === 'full'
            ? meta.lastFullSyncAt - DELTA_SAFETY_MS
            : undefined;
    console.info('[cache] sweep:albums dispatching with server', {
        baseUrl: server.url,
        delta: deltaCutoffMs !== undefined,
        serverId: server.id,
    });
    return runSweep<CachedAlbum>({
        ctx,
        deltaCutoffMs,
        fetchPage: fetchAlbumsPage(server, deltaCutoffMs !== undefined),
        itemDateMs: albumCreatedAtMs,
        writePage: writeAlbumsPage,
    });
};
