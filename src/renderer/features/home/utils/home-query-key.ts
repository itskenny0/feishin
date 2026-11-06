/**
 * Query key for a home shelf. The server id keeps one server's shelves from
 * painting on another after a switch (and lets dropSnapshotsForServer match
 * them); it goes last so the `['home', 'album']` / `['home', 'song']` prefixes
 * used by the favourite / rating optimistic updates still match.
 */
export const homeQueryKey = (kind: 'album' | 'song', shelf: string, serverId: string | undefined) =>
    ['home', kind, shelf, serverId] as const;
