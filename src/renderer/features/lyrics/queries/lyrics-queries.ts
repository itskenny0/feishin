// Cached query hook for the local-server-backed lyrics endpoint.
//
// Wraps `controller.getLyrics` (Jellyfin / "single structured" servers)
// with `useCachedQuery` so the IndexedDB cache primes the snapshot map
// before the network round-trip lands. The endpoint returns either a
// plain string or a SynchronizedLyricsArray; both round-trip cleanly
// through CachedLyrics by stashing the JSON-stringified form for the
// synced case and the raw string for the plain case.
//
// NOT migrated:
//   - The aggregated `lyricsQueries.songLyrics` (it composes local +
//     remote-auto + override into a LyricsQueryResult, which is not a
//     direct cache-row shape -- the local sub-fetch inside
//     `fetchLocalLyrics` is what reads/writes CachedLyrics).
//   - `lyricsQueries.search` / `lyricsQueries.songLyricsByRemoteId` --
//     these hit external providers (Genius, NetEase, etc.) and don't
//     belong in the local-server cache.
//   - The Subsonic getStructuredLyrics path -- different
//     `StructuredLyric[]` shape doesn't fit the CachedLyrics row.

import { controller } from '/@/renderer/api/controller';
import { queryKeys } from '/@/renderer/api/query-keys';
import { useCachedQuery } from '/@/renderer/cache';
import { LyricsResponse, SynchronizedLyricsArray } from '/@/shared/types/domain-types';

interface CachedQueryHookOptions {
    enabled?: boolean;
    staleTime?: number;
}

interface LyricsQueryArgs {
    options?: CachedQueryHookOptions;
    query: { songId: string };
    serverId: string | undefined;
}

const parseLyrics = (stored: string, synced: boolean): LyricsResponse | undefined => {
    if (!synced) return stored;
    try {
        return JSON.parse(stored) as SynchronizedLyricsArray;
    } catch {
        return undefined;
    }
};

export const useLyricsQuery = (args: LyricsQueryArgs) => {
    const { options, query, serverId } = args;
    const songId = query?.songId ?? '';

    return useCachedQuery<LyricsResponse>({
        apply: async (db, fresh) => {
            if (fresh === undefined || fresh === null) return;
            // For non-synced lyrics, an empty string means "no lyrics available".
            // Skip the cache write for those — they shouldn't occupy a row.
            if (typeof fresh === 'string' && fresh.trim().length === 0) return;
            const synced = typeof fresh !== 'string';
            await db.lyrics.put({
                __cachedAt: Date.now(),
                Lyrics: synced ? JSON.stringify(fresh) : (fresh as string),
                SongId: songId,
                Synced: synced,
            });
        },
        enabled: options?.enabled ?? Boolean(serverId && songId),
        fromCache: async (db) => {
            if (!songId) return undefined;
            const row = await db.lyrics.get(songId);
            if (!row) return undefined;
            return parseLyrics(row.Lyrics, row.Synced);
        },
        queryKey: queryKeys.songs.lyrics(serverId ?? '', { songId }),
        remote: (ctx) => {
            const call = controller.getLyrics;
            if (!call) return Promise.resolve('' as LyricsResponse);
            return call({
                apiClientProps: { serverId: serverId ?? '', signal: ctx.signal },
                query: { songId },
            }) as Promise<LyricsResponse>;
        },
        staleTime: options?.staleTime,
    });
};
