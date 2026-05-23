import { queryOptions, useQuery } from '@tanstack/react-query';
import isElectron from 'is-electron';
import { useMemo } from 'react';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { cachedSwr, readSnapshot, snapshotSwr } from '/@/renderer/cache';
import { queryClient, QueryHookArgs } from '/@/renderer/lib/react-query';
import { getServerById, useSettingsStore } from '/@/renderer/store';
import { hasFeature } from '/@/shared/api/utils';
import {
    FullLyricsMetadata,
    InternetProviderLyricResponse,
    InternetProviderLyricSearchResponse,
    LyricGetQuery,
    LyricSearchQuery,
    LyricsOverride,
    LyricsQuery,
    QueueSong,
    Song,
    StructuredLyric,
    SynchronizedLyricsArray,
} from '/@/shared/types/domain-types';
import { LyricSource } from '/@/shared/types/domain-types';
import { LyricsResponse } from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';

const lyricsIpc = isElectron() ? window.api.lyrics : null;

export type LyricsQueryResult = {
    local: FullLyricsMetadata | null | StructuredLyric[];
    overrideData: LyricsResponse | null;
    overrideSelection: LyricsOverride | null;
    remoteAuto: FullLyricsMetadata | null;
    selected: FullLyricsMetadata | null | StructuredLyric;
    selectedOffsetMs: number;
    selectedStructuredIndex: number;
    selectedSynced: boolean;
    suppressRemoteAuto: boolean;
};

// Match LRC lyrics format by https://github.com/ustbhuangyi/lyric-parser
// [mm:ss.SSS] text
const timeExp = /\[(\d{2,}):(\d{2})(?:\.(\d{2,3}))?]([^\n]+)(\n|$)/g;

// Match karaoke lyrics format returned by NetEase
// [SSS,???] text
const alternateTimeExp = /\[(\d*),(\d*)]([^\n]+)(\n|$)/g;

const formatLyrics = (lyrics: string) => {
    const synchronizedLines = lyrics.matchAll(timeExp);
    const formattedLyrics: SynchronizedLyricsArray = [];

    for (const line of synchronizedLines) {
        const [, minute, sec, ms, text] = line;
        const minutes = parseInt(minute, 10);
        const seconds = parseInt(sec, 10);
        const milis = ms?.length === 3 ? parseInt(ms, 10) : parseInt(ms, 10) * 10;

        const timeInMilis = (minutes * 60 + seconds) * 1000 + milis;

        formattedLyrics.push([timeInMilis, text]);
    }

    if (formattedLyrics.length > 0) return formattedLyrics;

    const alternateSynchronizedLines = lyrics.matchAll(alternateTimeExp);
    for (const line of alternateSynchronizedLines) {
        const [, timeInMilis, , text] = line;
        const cleanText = text
            .replaceAll(/\(\d+,\d+\)/g, '')
            .replaceAll(/\s,/g, ',')
            .replaceAll(/\s\./g, '.');
        formattedLyrics.push([Number(timeInMilis), cleanText]);
    }

    if (formattedLyrics.length > 0) return formattedLyrics;

    // If no synchronized lyrics were found, return the original lyrics
    return lyrics;
};

export const formatLyricsForDisplay = formatLyrics;

export function computeSelectedFromResult(
    result: Pick<
        LyricsQueryResult,
        'local' | 'overrideData' | 'overrideSelection' | 'remoteAuto' | 'selectedOffsetMs'
    >,
    preferLocalLyrics: boolean,
    selectedStructuredIndex: number,
): {
    selected: FullLyricsMetadata | null | StructuredLyric;
    selectedSynced: boolean;
} {
    const { local, overrideData, overrideSelection, remoteAuto, selectedOffsetMs } = result;

    // Override takes precedence over local and remote lyrics in all scenarios if available
    if (overrideSelection && overrideData) {
        const overrideLyrics: FullLyricsMetadata = {
            artist: overrideSelection.artist,
            lyrics: overrideData,
            name: overrideSelection.name,
            offsetMs: selectedOffsetMs,
            remote: overrideSelection.remote ?? true,
            source: overrideSelection.source,
        };
        return {
            selected: overrideLyrics,
            selectedSynced: Array.isArray(overrideData),
        };
    }

    const hasLocalLocal =
        (Array.isArray(local) && local.length > 0) ||
        (local != null && !Array.isArray(local) && 'lyrics' in local && Boolean(local.lyrics));

    // If setting is set to prefer local lyrics, return the local lyrics if available
    if (preferLocalLyrics && hasLocalLocal) {
        if (Array.isArray(local) && local.length > 0) {
            const item = local[Math.min(selectedStructuredIndex, local.length - 1)];
            return { selected: item, selectedSynced: item.synced };
        }

        if (local != null && !Array.isArray(local) && 'lyrics' in local && local.lyrics) {
            return { selected: local, selectedSynced: Array.isArray(local.lyrics) };
        }
    }

    // If remote lyrics are automatically fetched and available, return the remote auto lyrics
    if (remoteAuto) {
        return {
            selected: remoteAuto,
            selectedSynced: Array.isArray(remoteAuto.lyrics),
        };
    }

    // Otherwise, we just return the local lyrics if available, using structured lyrics if available
    if (Array.isArray(local) && local.length > 0) {
        const item = local[Math.min(selectedStructuredIndex, local.length - 1)];
        return { selected: item, selectedSynced: item.synced };
    }

    if (local != null && !Array.isArray(local) && 'lyrics' in local && local.lyrics) {
        return { selected: local, selectedSynced: Array.isArray(local.lyrics) };
    }

    // If no lyrics are available, return null
    return { selected: null, selectedSynced: false };
}

export async function fetchLocalLyrics(params: {
    serverId: string;
    signal?: AbortSignal;
    song: QueueSong;
}): Promise<FullLyricsMetadata | null | StructuredLyric[]> {
    const { serverId, signal, song } = params;
    const server = getServerById(serverId);
    if (!server) throw new Error('Server not found');

    if (hasFeature(server, ServerFeature.LYRICS_MULTIPLE_STRUCTURED)) {
        // Same rationale as the Jellyfin path below: missing-lyrics 404s are
        // expected and the user can't do anything with them. Silently fall
        // through to the empty-lyrics result.
        const subsonicLyrics = await api.controller
            .getStructuredLyrics({
                apiClientProps: { serverId, signal },
                query: { songId: song.id },
            })
            .catch(() => undefined);
        if (subsonicLyrics?.length) return subsonicLyrics;
    } else if (hasFeature(server, ServerFeature.LYRICS_SINGLE_STRUCTURED)) {
        // Songs without lyrics return 404 from Jellyfin - that's expected and
        // there's nothing actionable about it, so swallow the rejection
        // without logging. The browser still surfaces the network 404 in the
        // devtools network panel for anyone debugging on purpose.
        const jfLyrics = await api.controller
            .getLyrics({
                apiClientProps: { serverId, signal },
                query: { songId: song.id },
            })
            .catch(() => undefined);
        if (jfLyrics) {
            return {
                artist: song.artists?.[0]?.name,
                lyrics: jfLyrics,
                name: song.name,
                remote: false,
                source: server?.name ?? 'music server',
            };
        }
    } else if (song.lyrics) {
        return {
            artist: song.artists?.[0]?.name,
            lyrics: formatLyrics(song.lyrics),
            name: song.name,
            remote: false,
            source: server?.name ?? 'music server',
        };
    }
    return null;
}

export async function fetchRemoteLyricsAuto(song: QueueSong): Promise<FullLyricsMetadata | null> {
    const { fetch } = useSettingsStore.getState().lyrics;
    if (!fetch) return null;
    const remoteLyricsResult: InternetProviderLyricResponse | null =
        await lyricsIpc?.getRemoteLyricsBySong(song);

    if (remoteLyricsResult) {
        return {
            ...remoteLyricsResult,
            lyrics: formatLyrics(remoteLyricsResult.lyrics),
            remote: true,
        };
    }
    return null;
}

export async function fetchRemoteLyricsById(params: {
    remoteSongId: string;
    remoteSource: LyricSource;
    song?: QueueSong | Song;
}): Promise<LyricsResponse | null> {
    const result = await lyricsIpc?.getRemoteLyricsByRemoteId(params as LyricGetQuery);
    if (result) return formatLyrics(result);
    return null;
}

export function getDisplayOffset(
    selected: FullLyricsMetadata | null | StructuredLyric,
    storedOffsetMs: number,
    selectedStructuredIndex: number,
    local: FullLyricsMetadata | null | StructuredLyric[],
): number {
    if (selected && 'offsetMs' in selected && selected.offsetMs !== undefined) {
        return selected.offsetMs;
    }

    if (Array.isArray(local) && local.length > 0) {
        const item = local[Math.min(selectedStructuredIndex, local.length - 1)];
        return item.offsetMs ?? storedOffsetMs;
    }

    return storedOffsetMs;
}

const emptyResult = (): LyricsQueryResult => ({
    local: null,
    overrideData: null,
    overrideSelection: null,
    remoteAuto: null,
    selected: null,
    selectedOffsetMs: 0,
    selectedStructuredIndex: 0,
    selectedSynced: false,
    suppressRemoteAuto: false,
});

export const lyricsQueries = {
    search: (args: Omit<QueryHookArgs<LyricSearchQuery>, 'serverId'>) => {
        const key = queryKeys.songs.lyricsSearch(args.query);
        type LyricsSearchResponse = Record<LyricSource, InternetProviderLyricSearchResponse[]>;
        return queryOptions({
            gcTime: 1000 * 60 * 1,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<LyricsSearchResponse>({
                    ctx,
                    queryKey: key,
                    remote: async () =>
                        lyricsIpc
                            ? ((await lyricsIpc.searchRemoteLyrics(
                                  args.query,
                              )) as LyricsSearchResponse)
                            : ({} as LyricsSearchResponse),
                }),
            queryKey: key,
            staleTime: 1000 * 60 * 1,
            ...args.options,
        });
    },
    songLyrics: (args: QueryHookArgs<LyricsQuery>, song: QueueSong | undefined) => {
        const lyricsKey = queryKeys.songs.lyrics(args.serverId, args.query);

        // The heavy `remote` step assembles local + remote-auto + override
        // lyrics in parallel and persists the local flavour back to Dexie
        // so future loads can paint instantly across app restarts.
        const remote = async ({
            signal,
        }: {
            signal?: AbortSignal;
        }): Promise<LyricsQueryResult> => {
            if (!song) return emptyResult();

            const prev = queryClient.getQueryData<LyricsQueryResult>(lyricsKey);
            const overrideSelection = prev?.overrideSelection ?? null;
            const suppressRemoteAuto = prev?.suppressRemoteAuto ?? false;
            const selectedStructuredIndex = prev?.selectedStructuredIndex ?? 0;
            const selectedOffsetMs = prev?.selectedOffsetMs ?? 0;
            const preferLocalLyrics = useSettingsStore.getState().lyrics.preferLocalLyrics;

            // Fetch local lyrics
            const localPromise = fetchLocalLyrics({ serverId: args.serverId, signal, song });

            // Fetch remote auto lyrics
            const remoteAutoPromise =
                suppressRemoteAuto || !useSettingsStore.getState().lyrics.fetch
                    ? null
                    : fetchRemoteLyricsAuto(song);

            // Fetch override data
            const overrideDataPromise = overrideSelection
                ? fetchRemoteLyricsById({
                      remoteSongId: overrideSelection.id,
                      remoteSource: overrideSelection.source as LyricSource,
                      song,
                  })
                : null;

            const [local, remoteAuto, overrideData] = await Promise.all([
                localPromise,
                remoteAutoPromise,
                overrideDataPromise,
            ]);

            const partial: Pick<
                LyricsQueryResult,
                'local' | 'overrideData' | 'overrideSelection' | 'remoteAuto' | 'selectedOffsetMs'
            > = {
                local,
                overrideData,
                overrideSelection,
                remoteAuto,
                selectedOffsetMs,
            };
            const { selected, selectedSynced } = computeSelectedFromResult(
                partial,
                preferLocalLyrics,
                selectedStructuredIndex,
            );
            const displayOffset = getDisplayOffset(
                selected,
                selectedOffsetMs,
                selectedStructuredIndex,
                local,
            );

            const result: LyricsQueryResult = {
                ...emptyResult(),
                ...partial,
                selected,
                selectedOffsetMs: displayOffset,
                selectedStructuredIndex,
                selectedSynced,
                suppressRemoteAuto,
            };

            return result;
        };

        return queryOptions({
            gcTime: Infinity,
            // Paint the previous result from the snapshot map synchronously
            // so revisiting a song you've already loaded shows lyrics on
            // the first frame instead of a skeleton.
            placeholderData: (() => readSnapshot<LyricsQueryResult>(lyricsKey)) as never,
            queryFn: (ctx): Promise<LyricsQueryResult> =>
                cachedSwr<LyricsQueryResult>({
                    // Persist the lyrics payload to Dexie keyed by SongId so
                    // future loads (including across app restarts) can paint
                    // instantly. We only persist the `local` flavour because
                    // the remote-auto / override branches depend on third-
                    // party state that may change independently.
                    apply: async (db, fresh) => {
                        const local = fresh?.local;
                        if (!song?.id || !local || Array.isArray(local)) return;
                        const lyricsText =
                            typeof local.lyrics === 'string'
                                ? local.lyrics
                                : JSON.stringify(local.lyrics);
                        await db.lyrics.put({
                            __cachedAt: Date.now(),
                            Lyrics: lyricsText,
                            Payload: local,
                            SongId: song.id,
                            Synced: Array.isArray(local.lyrics),
                        });
                    },
                    ctx,
                    // Dexie read-through. If the lyrics for this track were
                    // cached on a previous load, return a synthetic seed so
                    // any concurrent mounts during the network round-trip
                    // see a primed value. The persisted `Payload` carries
                    // the full FullLyricsMetadata so artist/source/synced
                    // state survives an app restart, not just the lyric
                    // text itself.
                    fromCache: async (db) => {
                        if (!song?.id) return undefined;
                        const cached = await db.lyrics.get(song.id);
                        if (!cached?.Payload) return undefined;
                        return {
                            ...emptyResult(),
                            local: cached.Payload,
                            selected: cached.Payload,
                            selectedSynced: Array.isArray(cached.Payload.lyrics),
                        };
                    },
                    queryKey: lyricsKey,
                    remote: (rctx) => remote({ signal: rctx.signal }),
                }),
            queryKey: lyricsKey,
            staleTime: Infinity,
            ...args.options,
        });
    },
    songLyricsByRemoteId: (args: QueryHookArgs<Partial<LyricGetQuery>>) => {
        const key = queryKeys.songs.lyricsByRemoteId(args.query);
        return queryOptions({
            gcTime: Infinity,
            initialData: (() => readSnapshot(key)) as never,
            initialDataUpdatedAt: 0,
            queryFn: (ctx) =>
                snapshotSwr<LyricsResponse | null>({
                    ctx,
                    queryKey: key,
                    remote: async () => {
                        const q = args.query;
                        if (!q?.remoteSongId || !q?.remoteSource) return null;
                        return fetchRemoteLyricsById({
                            remoteSongId: q.remoteSongId,
                            remoteSource: q.remoteSource as LyricSource,
                            song: q.song as QueueSong | Song | undefined,
                        });
                    },
                }),
            queryKey: key,
            staleTime: Infinity,
            ...args.options,
        });
    },
};

/**
 * Did the lyrics query resolve to actual lyrics for this song?
 *
 * Subscribes to the same TanStack key as the Lyrics component, so the
 * request only fires once across both consumers. Returns:
 *   - `null` while the query is still loading (caller should keep the
 *     UI in place to avoid a flash of "no lyrics" → lyrics).
 *   - `true` once we have a resolved selection (synced or unsynced).
 *   - `false` once the fetch completes with nothing to show.
 *
 * Used by the mobile fullscreen player to hide the lyrics preview card
 * entirely when there are no lyrics — keeping it would just show an
 * empty box that scrolls into view below the cover.
 */
export const useHasLyrics = (song: QueueSong | undefined): boolean | null => {
    const enabled = useMemo(
        () => Boolean(song?.id && song?._serverId),
        [song?._serverId, song?.id],
    );
    const { data, isLoading } = useQuery(
        lyricsQueries.songLyrics(
            {
                options: { enabled },
                query: { songId: song?.id || '' },
                serverId: song?._serverId || '',
            },
            song,
        ),
    );

    if (!enabled) return false;
    if (isLoading && !data) return null;
    return Boolean(data?.selected);
};
