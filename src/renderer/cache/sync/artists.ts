import type { LibraryCacheDb } from '../db';
import type { CachedArtist } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { AlbumArtistListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const fetchArtistsPage =
    (server: ServerListItem) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedArtist[]; total: number }> => {
        const result = await controller.getAlbumArtistList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: AlbumArtistListSort.NAME,
                sortOrder: SortOrder.ASC,
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

export const runArtistsSweep = (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    console.info('[cache] sweep:artists dispatching with server', {
        baseUrl: server.url,
        serverId: server.id,
    });
    return runSweep<CachedArtist>({
        ctx,
        fetchPage: fetchArtistsPage(server),
        writePage: writeArtistsPage,
    });
};
