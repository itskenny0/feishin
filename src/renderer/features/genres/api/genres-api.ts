import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { cachedSwr, filterGenresLocal, readEntityCountFallback, readSnapshot, toCachedGenreRow } from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import { useCurrentServerId } from '/@/renderer/store';
import {
    GenreListQuery,
    GenreListResponse,
    GenreListSort,
    ListCountQuery,
    SortOrder,
} from '/@/shared/types/domain-types';

export const genresQueries = {
    list: (args: QueryHookArgs<GenreListQuery>) => {
        const key = queryKeys.genres.list(args.serverId, args.query);
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<GenreListResponse>({
                    apply: async (db, fresh) => {
                        const items = fresh?.items ?? [];
                        if (items.length > 0) {
                            await db.genres.bulkPut(items.map(toCachedGenreRow));
                        }
                    },
                    ctx,
                    // Cache-first: pipe the full row set through
                    // filterGenresLocal so searchTerm filtering, sort, and
                    // pagination match what the network would return.
                    fromCache: async (db) => {
                        const rows = await db.genres.toArray();
                        if (rows.length === 0) return undefined;
                        return filterGenresLocal({ query: args.query, rows }) ?? undefined;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller.getGenreList({
                            apiClientProps: { serverId: args.serverId, signal },
                            query: args.query,
                        }) as Promise<GenreListResponse>,
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
    listCount: (args: QueryHookArgs<ListCountQuery<GenreListQuery>>) => {
        const key = queryKeys.genres.count(
            args.serverId,
            Object.keys(args.query).length === 0 ? undefined : args.query,
        );
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            initialData: (() => readEntityCountFallback(key, 'genres')) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                cachedSwr<number>({
                    ctx,
                    fromCache: async (db) => {
                        if (args.query.searchTerm) {
                            const rows = await db.genres.toArray();
                            const result = filterGenresLocal({
                                query: { ...args.query, startIndex: 0 },
                                rows,
                            });
                            if (result !== undefined) return result.totalRecordCount ?? 0;
                        }
                        const cachedCount = await db.genres.count();
                        return cachedCount > 0 ? cachedCount : undefined;
                    },
                    queryKey: key,
                    remote: ({ signal }) =>
                        api.controller
                            .getGenreList({
                                apiClientProps: { serverId: args.serverId, signal },
                                query: { ...args.query, limit: 1, startIndex: 0 },
                            })
                            .then((result) => result?.totalRecordCount ?? 0),
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
};

export const useGenreList = () => {
    const serverId = useCurrentServerId();

    return useSuspenseQuery({
        ...genresQueries.list({
            query: {
                limit: -1,
                sortBy: GenreListSort.NAME,
                sortOrder: SortOrder.ASC,
                startIndex: 0,
            },
            serverId,
        }),
        gcTime: Infinity,
        staleTime: Infinity,
    });
};

/**
 * Expand a single genre selection into every genre whose name contains the
 * selected name as a substring (case-insensitive). Clicking "Metal" returns
 * the IDs for "Metal", "Death Metal", "Black Metal", "Heavy Metal", etc.
 *
 * Jellyfin/Subsonic genres are flat strings with no taxonomy, so libraries
 * that tag sub-genres specifically end up with no songs visible when the
 * user clicks the broad bucket. This is a pragmatic fix — name-substring
 * matching catches the common case (parent contained in child) without
 * needing genre hierarchies on the server.
 *
 * Edge cases:
 *  - Empty / whitespace `primaryGenreId` (race during context-init) returns
 *    []. Callers should NOT play / browse with an empty filter — on Jellyfin
 *    a falsy genreIds query maps to "all songs in the library".
 *  - `primaryGenreId` not in the cached genre list: returns just
 *    [primaryGenreId] so stale links still resolve to the literal genre.
 *  - The primary id is ALWAYS first in the returned array, so callers that
 *    truncate to genreIds[0] (e.g., the Subsonic single-genre paths) at
 *    least play the user's actual selection rather than an alphabetically-
 *    earlier sibling.
 */
export const useFuzzyGenreIds = (primaryGenreId: string): string[] => {
    const { data: genres } = useGenreList();
    return useMemo(() => {
        const trimmed = primaryGenreId.trim();
        if (!trimmed) return [];
        if (!genres?.items) return [trimmed];
        const primary = genres.items.find((g) => g.id === trimmed);
        if (!primary) return [trimmed];
        const needle = primary.name.trim().toLowerCase();
        if (!needle) return [trimmed];
        const matched = genres.items.filter((g) => g.name.toLowerCase().includes(needle));
        const matchedIds = matched.map((g) => g.id).filter((id) => id !== trimmed);
        return [trimmed, ...matchedIds];
    }, [genres, primaryGenreId]);
};
