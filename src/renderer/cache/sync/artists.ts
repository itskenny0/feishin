import type { LibraryCacheDb } from '../db';
import type { ArtistKind, CachedArtist } from '../types';
import type { SweepContext } from './sweep';

import { toCachedArtistRow } from '../row-mappers';
import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import {
    AlbumArtistListSort,
    ArtistListSort,
    ServerListItem,
    SortOrder,
} from '/@/shared/types/domain-types';

const DELTA_SAFETY_MS = 60_000;

// Sweep both AlbumArtist (album-grouping) and Artist (track-credit) kinds in
// a single logical "artists" sweep. The Jellyfin API splits these two roles
// across `getAlbumArtistList` and `getArtistList`; without sweeping both the
// song-artist grid never hits cache (loadArtistsRows filters Kind === 'Artist').
// Backends like Navidrome alias the two endpoints to the same data — the
// second pass duplicates rows under a different Kind, which is the right
// behaviour for the song-artist grid on those servers.

const fetchAlbumArtistPage = async (
    server: ServerListItem,
    startIndex: number,
    limit: number,
    deltaMode: boolean,
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

    const items: CachedArtist[] = (result?.items ?? []).map((artist) => ({
        ...toCachedArtistRow(artist, 'AlbumArtist'),
        AlbumArtistId: artist.id,
        DateLastSaved: artist.lastPlayedAt ?? '',
        SortName: artist.name,
    }));

    return {
        items,
        total: result?.totalRecordCount ?? 0,
    };
};

const fetchArtistPage = async (
    server: ServerListItem,
    startIndex: number,
    limit: number,
    deltaMode: boolean,
    signal: AbortSignal,
): Promise<{ items: CachedArtist[]; total: number }> => {
    const result = await controller.getArtistList({
        apiClientProps: { serverId: server.id, signal },
        query: {
            limit,
            sortBy: deltaMode ? ArtistListSort.RECENTLY_ADDED : ArtistListSort.NAME,
            sortOrder: deltaMode ? SortOrder.DESC : SortOrder.ASC,
            startIndex,
        },
    });

    const items: CachedArtist[] = (result?.items ?? []).map((artist) => ({
        ...toCachedArtistRow(artist, 'Artist'),
        AlbumArtistId: artist.id,
        DateLastSaved: artist.lastPlayedAt ?? '',
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
    const created = artist.Payload.createdAt;
    if (!created) return undefined;
    const ms = Date.parse(created);
    return Number.isFinite(ms) ? ms : undefined;
};

const probeTotal = async (
    fetcher: (
        server: ServerListItem,
        startIndex: number,
        limit: number,
        deltaMode: boolean,
        signal: AbortSignal,
    ) => Promise<{ items: CachedArtist[]; total: number }>,
    server: ServerListItem,
    deltaMode: boolean,
    signal: AbortSignal,
    label: ArtistKind,
): Promise<number> => {
    try {
        const result = await fetcher(server, 0, 1, deltaMode, signal);
        return result.total;
    } catch (err) {
        if ((err as Error)?.name === 'AbortError' || signal.aborted) throw err;
        console.warn(`[cache] sweep:artists ${label} probe failed`, err);
        return 0;
    }
};

// Build a virtual paginator that runSweep can drive as if it were a single
// stream. Cumulative `startIndex` from runSweep is split across the two kinds
// using the AlbumArtist total as the boundary; the boundary page is padded
// from the Artist kind so runSweep doesn't treat the partial AlbumArtist page
// as the final page of the sweep.
const buildVirtualFetcher =
    (server: ServerListItem, deltaMode: boolean, albumArtistTotal: number, artistTotal: number) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedArtist[]; total: number }> => {
        const combinedTotal = albumArtistTotal + artistTotal;

        // Past the AlbumArtist range entirely — pure Artist fetch.
        if (startIndex >= albumArtistTotal) {
            const artistOffset = startIndex - albumArtistTotal;
            const page = await fetchArtistPage(server, artistOffset, limit, deltaMode, signal);
            return { items: page.items, total: combinedTotal };
        }

        // Inside the AlbumArtist range.
        const albumArtistPage = await fetchAlbumArtistPage(
            server,
            startIndex,
            limit,
            deltaMode,
            signal,
        );

        // No padding needed: page filled to the limit (runSweep will advance
        // startIndex normally on the next call), or this isn't actually the
        // boundary page (still more AlbumArtists left after this one).
        const albumArtistRemaining = Math.max(0, albumArtistTotal - startIndex);
        if (
            albumArtistPage.items.length >= limit ||
            albumArtistPage.items.length < albumArtistRemaining
        ) {
            return { items: albumArtistPage.items, total: combinedTotal };
        }

        // Boundary page: AlbumArtists ran short. In delta mode, do NOT pad —
        // mixing the two kinds inside a single page breaks the date-ordered
        // cutoff walker in runSweep (the cutoff might fire on a stale Artist
        // and skip newer AlbumArtists or vice versa). The delta pass for
        // Artist kind would still be picked up on the next sync; the small
        // window of missed Artist-only delta updates is preferable to an
        // incorrect cutoff. In full-sync mode we DO pad so runSweep keeps
        // iterating past the AlbumArtist boundary.
        if (deltaMode || artistTotal === 0) {
            return { items: albumArtistPage.items, total: combinedTotal };
        }

        const padNeeded = limit - albumArtistPage.items.length;
        const padPage = await fetchArtistPage(server, 0, padNeeded, deltaMode, signal);
        return {
            items: [...albumArtistPage.items, ...padPage.items],
            total: combinedTotal,
        };
    };

export const runArtistsSweep = async (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    const meta = await ctx.db.syncMeta.get('artists');
    const deltaCutoffMs =
        meta?.lastFullSyncAt && meta.hydrationState === 'full'
            ? meta.lastFullSyncAt - DELTA_SAFETY_MS
            : undefined;
    const deltaMode = deltaCutoffMs !== undefined;

    console.info('[cache] sweep:artists dispatching with server', {
        baseUrl: server.url,
        delta: deltaMode,
        serverId: server.id,
    });

    // Probe both kinds upfront so the virtual paginator can route any
    // cumulative startIndex (including a resume offset from a partially
    // completed prior sweep) to the correct backend call without guessing.
    const albumArtistTotal = await probeTotal(
        fetchAlbumArtistPage,
        server,
        deltaMode,
        ctx.signal,
        'AlbumArtist',
    );
    if (ctx.signal.aborted) {
        console.info('[cache] sweep:artists aborted during probe');
        return;
    }
    const artistTotal = await probeTotal(fetchArtistPage, server, deltaMode, ctx.signal, 'Artist');
    if (ctx.signal.aborted) {
        console.info('[cache] sweep:artists aborted during probe');
        return;
    }

    console.info('[cache] sweep:artists kinds probed', {
        albumArtistTotal,
        artistTotal,
        delta: deltaMode,
    });

    return runSweep<CachedArtist>({
        ctx,
        deltaCutoffMs,
        fetchPage: buildVirtualFetcher(server, deltaMode, albumArtistTotal, artistTotal),
        itemDateMs: artistCreatedAtMs,
        writePage: writeArtistsPage,
    });
};
