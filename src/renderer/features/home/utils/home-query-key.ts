import type { QueryClient } from '@tanstack/react-query';

/**
 * Query key for a home shelf. The server id keeps one server's shelves from
 * painting on another after a switch (and lets dropSnapshotsForServer match
 * them); it goes last so the `['home', 'album']` / `['home', 'song']` prefixes
 * used by the favourite / rating optimistic updates still match.
 */
export const homeQueryKey = (kind: 'album' | 'song', shelf: string, serverId: string | undefined) =>
    ['home', kind, shelf, serverId] as const;

// Refresh the shelves a recorded play changes (both album and song variants).
export const invalidatePlayedHomeShelves = (queryClient: QueryClient, serverId: string) =>
    Promise.all(
        (['album', 'song'] as const).flatMap((kind) =>
            ['mostPlayed', 'recentlyPlayed'].map((shelf) =>
                queryClient.invalidateQueries({ queryKey: homeQueryKey(kind, shelf, serverId) }),
            ),
        ),
    );
