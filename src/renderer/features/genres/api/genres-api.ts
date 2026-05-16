import { queryOptions, useSuspenseQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import { useCurrentServerId } from '/@/renderer/store';
import {
    GenreListQuery,
    GenreListSort,
    ListCountQuery,
    SortOrder,
} from '/@/shared/types/domain-types';

export const genresQueries = {
    list: (args: QueryHookArgs<GenreListQuery>) => {
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            queryFn: ({ signal }) => {
                return api.controller.getGenreList({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
            },
            queryKey: queryKeys.genres.list(args.serverId, args.query),
            staleTime: 1000 * 60 * 60,
            ...args.options,
        });
    },
    listCount: (args: QueryHookArgs<ListCountQuery<GenreListQuery>>) => {
        return queryOptions({
            gcTime: 1000 * 60 * 60,
            queryFn: ({ signal }) => {
                return api.controller
                    .getGenreList({
                        apiClientProps: { serverId: args.serverId, signal },
                        query: { ...args.query, limit: 1, startIndex: 0 },
                    })
                    .then((result) => result?.totalRecordCount ?? 0);
            },
            queryKey: queryKeys.genres.count(
                args.serverId,
                Object.keys(args.query).length === 0 ? undefined : args.query,
            ),
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
 * Falls back to [primaryGenreId] when the genre isn't found in the cached
 * list, so a stale link still resolves to the literal genre.
 */
export const useFuzzyGenreIds = (primaryGenreId: string): string[] => {
    const { data: genres } = useGenreList();
    return useMemo(() => {
        if (!genres?.items) return [primaryGenreId];
        const primary = genres.items.find((g) => g.id === primaryGenreId);
        if (!primary) return [primaryGenreId];
        const needle = primary.name.trim().toLowerCase();
        if (!needle) return [primaryGenreId];
        const matches = genres.items.filter((g) => g.name.toLowerCase().includes(needle));
        // Always include the primary id even if name-matching somehow excludes
        // it (e.g. weird casing in a server normaliser).
        const ids = new Set(matches.map((g) => g.id));
        ids.add(primaryGenreId);
        return Array.from(ids);
    }, [genres, primaryGenreId]);
};
