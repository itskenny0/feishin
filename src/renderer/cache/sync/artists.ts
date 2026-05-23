import type { LibraryCacheDb } from '../db';
import type { CachedArtist } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { AlbumArtistListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const DELTA_SAFETY_MS = 60_000;

const fetchArtistsPage =
    (server: ServerListItem, deltaMode: boolean) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedArtist[]; total: number }> => {
        const result = await controller.getAlbumArtistList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: deltaMode ? AlbumArtistListSort.RECENTLY_ADDED : AlbumArtistListSort.NAME,
                sortOrder: deltaMode ? SortOrder.DESC : SortOrder.ASC,
                startIndex,
            },
        });

        const now = Date.now();
        const items: CachedArtist[] = (result?.items ?? []).map((artist) => ({
            __cachedAt: now,
            AlbumArtistId: artist.id,
            DateLastSaved: artist.lastPlayedAt ?? '',
            Id: artist.id,
            Kind: 'AlbumArtist' as const,
            Name: artist.name,
            Payload: artist,
            SortName: artist.name,
        }));

        return {
            items,
            total: result?.totalRecordCount ?? 0,
        };
    };

const writeArtistsPage = async (db: LibraryCacheDb, items: CachedArtist[]): Promise<void> => {
    await db.artists.bulkPut(items);
};

const artistCreatedAtMs = (artist: CachedArtist): number | undefined => {
    const created = (artist.Payload as { createdAt?: string }).createdAt;
    if (!created) return undefined;
    const ms = Date.parse(created);
    return Number.isFinite(ms) ? ms : undefined;
};

export const runArtistsSweep = async (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    const meta = await ctx.db.syncMeta.get('artists');
    const deltaCutoffMs =
        meta?.lastFullSyncAt && meta.hydrationState === 'full'
            ? meta.lastFullSyncAt - DELTA_SAFETY_MS
            : undefined;
    console.info('[cache] sweep:artists dispatching with server', {
        baseUrl: server.url,
        delta: deltaCutoffMs !== undefined,
        serverId: server.id,
    });
    return runSweep<CachedArtist>({
        ctx,
        deltaCutoffMs,
        fetchPage: fetchArtistsPage(server, deltaCutoffMs !== undefined),
        itemDateMs: artistCreatedAtMs,
        writePage: writeArtistsPage,
    });
};
