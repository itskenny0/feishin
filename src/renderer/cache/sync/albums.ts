import type { LibraryCacheDb } from '../db';
import type { CachedAlbum } from '../types';
import type { SweepContext } from './sweep';

import { toCachedAlbumRow } from '../row-mappers';
import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { AlbumListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const DELTA_SAFETY_MS = 60_000;

// Lean Jellyfin Fields for the SWEEP path only (overrides the heavier
// JF_FIELDS.ALBUM_LIST via _custom). Drops the fields nothing in the
// cache/search/filter/sort/index path reads — People, Tags, Studios, Path,
// ProviderIds (People + Path are the heaviest) — and keeps the load-bearing
// ones: SortName (name sort + Dexie index), ChildCount (songCount sort), and
// BOTH Genres + GenreItems. `Genres` looks redundant (genres[] is built from
// GenreItems) BUT Jellyfin only returns GenreItems when Genres is co-requested
// — verified on-device: `GenreItems` alone → 0/60 albums carry genres, dropping
// the genre filter entirely. So Genres must stay. Detail/home/queue fetches keep
// the full fields (they don't set _custom.Fields).
const LEAN_ALBUM_SWEEP_FIELDS = ['ChildCount', 'Genres', 'GenreItems', 'SortName'];

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
                _custom: {
                    // Suppress the per-page COUNT(*) on pages 2..N — page 1
                    // seeds the total; runSweep's "don't overwrite total with 0"
                    // guard keeps the suppressed 0s from truncating the loop.
                    EnableTotalRecordCount: startIndex === 0,
                    Fields: LEAN_ALBUM_SWEEP_FIELDS,
                },
                limit,
                sortBy: deltaMode ? AlbumListSort.RECENTLY_ADDED : AlbumListSort.NAME,
                sortOrder: deltaMode ? SortOrder.DESC : SortOrder.ASC,
                startIndex,
            },
        });

        const items: CachedAlbum[] = (result?.items ?? []).map(toCachedAlbumRow);

        return {
            items,
            total: result?.totalRecordCount ?? 0,
        };
    };

const writeAlbumsPage = async (db: LibraryCacheDb, items: CachedAlbum[]): Promise<void> => {
    await db.albums.bulkPut(items);
};

const albumCreatedAtMs = (album: CachedAlbum): number | undefined => {
    const created = album.Payload.createdAt;
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
