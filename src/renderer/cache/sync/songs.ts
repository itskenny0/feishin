import type { LibraryCacheDb } from '../db';
import type { CachedSong } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { ServerListItem, SongListSort, SortOrder } from '/@/shared/types/domain-types';

// Safety margin shaved off `lastFullSyncAt` before using it as a delta
// cutoff. Server clocks and our local clock can drift by a few seconds,
// and an item created at the exact instant of the previous sync might
// otherwise be skipped on this one.
const DELTA_SAFETY_MS = 60_000;

// Lean Jellyfin Fields for the SWEEP path only (overrides the heavier
// JF_FIELDS.SONG via _custom — note that constant is shared by EVERY song path
// incl. playback queue building, so it must NOT be edited directly). Drops
// People, Tags, ProviderIds, ParentId, Genres(name-only) — none read by the
// cache/search/filter/sort/index path. KEEPS: DateCreated (drives the delta
// short-circuit), MediaSources (the `channels` offline sort), SortName (name
// sort). Detail / queue / playlist / download fetches keep the full fields.
const LEAN_SONG_SWEEP_FIELDS = ['DateCreated', 'MediaSources', 'SortName'];

const fetchSongsPage =
    (server: ServerListItem, deltaMode: boolean) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedSong[]; total: number }> => {
        const result = await controller.getSongList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                _custom: {
                    EnableTotalRecordCount: startIndex === 0,
                    Fields: LEAN_SONG_SWEEP_FIELDS,
                },
                limit,
                sortBy: deltaMode ? SongListSort.RECENTLY_ADDED : SongListSort.NAME,
                sortOrder: deltaMode ? SortOrder.DESC : SortOrder.ASC,
                startIndex,
            },
        });

        const now = Date.now();
        const items: CachedSong[] = (result?.items ?? []).map((song) => ({
            __cachedAt: now,
            AlbumArtistId: song.albumArtists?.[0]?.id,
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

const songCreatedAtMs = (song: CachedSong): number | undefined => {
    // Jellyfin's `createdAt` is the original ingest timestamp; sort by
    // RECENTLY_ADDED orders by it. We compare against the user's
    // `lastFullSyncAt` to short-circuit pagination once we've walked
    // past the items added since then.
    const created = song.Payload.createdAt;
    if (!created) return undefined;
    const ms = Date.parse(created);
    return Number.isFinite(ms) ? ms : undefined;
};

export const runSongsSweep = async (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    const meta = await ctx.db.syncMeta.get('songs');
    const deltaCutoffMs =
        meta?.lastFullSyncAt && meta.hydrationState === 'full'
            ? meta.lastFullSyncAt - DELTA_SAFETY_MS
            : undefined;
    console.info('[cache] sweep:songs dispatching with server', {
        baseUrl: server.url,
        delta: deltaCutoffMs !== undefined,
        serverId: server.id,
    });
    return runSweep<CachedSong>({
        ctx,
        deltaCutoffMs,
        fetchPage: fetchSongsPage(server, deltaCutoffMs !== undefined),
        itemDateMs: songCreatedAtMs,
        writePage: writeSongsPage,
    });
};
