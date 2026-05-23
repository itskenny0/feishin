// Cached query hooks for the genres feature.
//
// These wrap the controller call with `useCachedQuery` (plus a hand-rolled
// suspense variant) so the IndexedDB cache primes the snapshot map before
// the network round-trip lands. The signature matches what the existing
// component callers expect once they migrate off the raw
// `useQuery(genresQueries.list(...))` form: a `QueryHookArgs`-shaped input
// plus an `options.enabled` / `options.staleTime` pass-through.

import type { QueryKey } from '@tanstack/react-query';

import { useSuspenseQuery } from '@tanstack/react-query';

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { cachedSwr, markSearchDirty, readSnapshot, useCachedQuery } from '/@/renderer/cache';
import { Genre, GenreListQuery, GenreListResponse } from '/@/shared/types/domain-types';

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

interface GenreQueryArgs {
    options?: CachedQueryHookOptions;
    query: GenreListQuery;
    serverId: string | undefined;
}

interface GenreSuspenseQueryArgs extends GenreQueryArgs {
    // Some callers (the home page) need a custom queryKey so the same
    // list response can be cached under a stable home-only slot. Optional —
    // defaults to `queryKeys.genres.list(serverId, query)`.
    queryKey?: QueryKey;
}

const nowMs = () => Date.now();

const toCachedGenreRow = (genre: Genre) => ({
    __cachedAt: nowMs(),
    Id: genre.id,
    Name: genre.name ?? '',
    Payload: genre,
    SortName: (genre.name ?? '').toLowerCase(),
});

// ---------------------------------------------------------------------------
// Non-suspense: used by the filter-panel call sites
// ---------------------------------------------------------------------------

export const useGenreListQuery = (args: GenreQueryArgs) => {
    const { options, query, serverId } = args;

    return useCachedQuery<GenreListResponse>({
        apply: async (db, fresh) => {
            const items = fresh?.items ?? [];
            if (items.length === 0) return;
            await db.genres.bulkPut(items.map(toCachedGenreRow));
            // Genres aren't part of the in-memory search indexes today, but
            // marking all dirty matches the convention used by the other
            // entity-list write-throughs in this codebase.
            markSearchDirty('all');
        },
        enabled: options?.enabled ?? Boolean(serverId),
        fromCache: async (db) => {
            const rows = await db.genres.orderBy('SortName').toArray();
            if (rows.length === 0) return undefined;
            return {
                items: rows.map((r) => r.Payload),
                startIndex: 0,
                totalRecordCount: rows.length,
            };
        },
        queryKey: queryKeys.genres.list(serverId ?? '', query),
        remote: (ctx) =>
            controller.getGenreList({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query,
            }) as Promise<GenreListResponse>,
        staleTime: options?.staleTime,
    });
};

// ---------------------------------------------------------------------------
// Suspense: used by featured-genres on the home page and by useGenreList
// ---------------------------------------------------------------------------

export const useGenreListSuspenseQuery = (args: GenreSuspenseQueryArgs) => {
    const { options, query, queryKey: queryKeyOverride, serverId } = args;

    const queryKey = queryKeyOverride ?? queryKeys.genres.list(serverId ?? '', query);

    return useSuspenseQuery<GenreListResponse>({
        // initialData fed synchronously from the in-memory snapshot map.
        // When a snapshot exists this lets useSuspenseQuery render without
        // suspending, so the home page paints immediately after the first
        // session. `initialDataUpdatedAt: 0` marks the data as already stale
        // so react-query still kicks off a background refetch.
        initialData: () => readSnapshot<GenreListResponse>(queryKey),
        initialDataUpdatedAt: 0,
        queryFn: (ctx) =>
            cachedSwr<GenreListResponse>({
                apply: async (db, fresh) => {
                    const items = fresh?.items ?? [];
                    if (items.length === 0) return;
                    await db.genres.bulkPut(items.map(toCachedGenreRow));
                    markSearchDirty('all');
                },
                ctx,
                fromCache: async (db) => {
                    const rows = await db.genres.orderBy('SortName').toArray();
                    if (rows.length === 0) return undefined;
                    return {
                        items: rows.map((r) => r.Payload),
                        startIndex: 0,
                        totalRecordCount: rows.length,
                    };
                },
                queryKey,
                remote: ({ signal }) =>
                    controller.getGenreList({
                        apiClientProps: { serverId: serverId ?? '', signal },
                        query,
                    }) as Promise<GenreListResponse>,
            }),
        queryKey,
        staleTime: options?.staleTime,
    });
};
