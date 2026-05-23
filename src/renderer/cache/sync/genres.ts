import type { LibraryCacheDb } from '../db';
import type { CachedGenre } from '../types';
import type { SweepContext } from './sweep';

import { runSweep } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { GenreListSort, ServerListItem, SortOrder } from '/@/shared/types/domain-types';

const fetchGenresPage =
    (server: ServerListItem) =>
    async (
        startIndex: number,
        limit: number,
        signal: AbortSignal,
    ): Promise<{ items: CachedGenre[]; total: number }> => {
        const result = await controller.getGenreList({
            apiClientProps: { serverId: server.id, signal },
            query: {
                limit,
                sortBy: GenreListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex,
            },
        });

        const now = Date.now();
        const items: CachedGenre[] = (result?.items ?? []).map((genre) => ({
            __cachedAt: now,
            Id: genre.id,
            Name: genre.name ?? '',
            Payload: genre,
            SortName: (genre.name ?? '').toLowerCase(),
        }));

        return {
            items,
            total: result?.totalRecordCount ?? 0,
        };
    };

const writeGenresPage = async (db: LibraryCacheDb, items: CachedGenre[]): Promise<void> => {
    await db.genres.bulkPut(items);
};

export const runGenresSweep = (ctx: SweepContext, server: ServerListItem): Promise<void> => {
    console.info('[cache] sweep:genres dispatching with server', {
        baseUrl: server.url,
        serverId: server.id,
    });
    return runSweep<CachedGenre>({
        ctx,
        fetchPage: fetchGenresPage(server),
        writePage: writeGenresPage,
    });
};
