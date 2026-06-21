import type {
    FullLyricsMetadata,
    ServerListItem,
    Song,
    StructuredLyric,
} from '/@/shared/types/domain-types';

import type { CachedLyrics, CachedSong } from '../types';
import type { SweepContext } from './sweep';

import { useCacheStore } from '../store';
import { isSweepNetworkError } from './sweep';

import { controller } from '/@/renderer/api/controller';
import { getIsOnline } from '/@/renderer/lib/network-status';
import { hasFeature } from '/@/shared/api/utils';
import { ServerFeature } from '/@/shared/types/features-types';
import { runWithConcurrency } from '/@/shared/utils/promise-pool';

/**
 * Convert a `fetchLocalLyrics` result into the CachedLyrics row the lyrics
 * sweep persists.
 *
 * A `null` / empty result is stored as a NEGATIVE marker (empty Lyrics, no
 * Payload) rather than skipped, so the sweep can skip the song on its next pass
 * without re-hitting the server. The on-demand lyrics reader returns `undefined`
 * for a Payload-less row, so a negative marker stays transparent to the
 * on-demand internet lookup.
 */
export const toLyricsRow = (
    songId: string,
    result: FullLyricsMetadata | null | StructuredLyric | StructuredLyric[] | undefined,
    nowMs: number,
): CachedLyrics => {
    // StructuredLyric is FullLyricsMetadata-compatible; the first entry is the
    // primary lyric (additional entries are translations we don't cache in v1).
    const meta = Array.isArray(result) ? result[0] : result;
    if (!meta || meta.lyrics == null) {
        return {
            __cachedAt: nowMs,
            Lyrics: '',
            Payload: undefined,
            SongId: songId,
            Synced: false,
        };
    }
    const synced = Array.isArray(meta.lyrics);
    return {
        __cachedAt: nowMs,
        Lyrics: synced ? JSON.stringify(meta.lyrics) : (meta.lyrics as string),
        Payload: meta as FullLyricsMetadata,
        SongId: songId,
        Synced: synced,
    };
};

type LyricsFetchResult = FullLyricsMetadata | null | StructuredLyric[];

// Server-only lyrics fetch — mirrors features/lyrics `fetchLocalLyrics` but at
// the cache→api layer (the cache must never import from features). Embedded
// `song.lyrics` costs no network. Underlying 404s/errors are swallowed to
// `null` exactly like the on-demand player path, so a song with genuinely no
// server lyrics is recorded as a negative marker by `toLyricsRow`.
const fetchServerLyrics = async (
    server: ServerListItem,
    song: Song,
    signal: AbortSignal,
): Promise<LyricsFetchResult> => {
    const source = server.name ?? 'music server';
    if (hasFeature(server, ServerFeature.LYRICS_MULTIPLE_STRUCTURED)) {
        const res = await controller
            .getStructuredLyrics({
                apiClientProps: { serverId: server.id, signal },
                query: { songId: song.id },
            })
            .catch(() => undefined);
        if (res?.length) return res;
    } else if (hasFeature(server, ServerFeature.LYRICS_SINGLE_STRUCTURED)) {
        const res = await controller
            .getLyrics({
                apiClientProps: { serverId: server.id, signal },
                query: { songId: song.id },
            })
            .catch(() => undefined);
        if (res) {
            return {
                artist: song.artists?.[0]?.name,
                lyrics: res,
                name: song.name,
                remote: false,
                source,
            };
        }
    } else if (song.lyrics) {
        return {
            artist: song.artists?.[0]?.name,
            lyrics: song.lyrics,
            name: song.name,
            remote: false,
            source,
        };
    }
    return null;
};

const LYRICS_CHUNK = 200;
const LYRICS_CONCURRENCY = 6;

export interface LyricsSweepDeps {
    // Injected for tests; defaults to the server-only fetch above.
    fetchLyrics: (song: Song, signal: AbortSignal) => Promise<LyricsFetchResult>;
    now: () => number;
}

/**
 * Sweep server/local lyrics for every cached song into `db.lyrics` so they are
 * available offline. Iterates the already-synced `db.songs` (this sweep runs
 * AFTER the songs sweep), skips any song that already has a lyrics row (positive
 * or negative), and resumes from a `syncMeta('lyrics')` checkpoint. Bounded
 * concurrency keeps the server load polite; an offline transition pauses the
 * sweep with its checkpoint preserved rather than recording false negatives for
 * the whole tail.
 */
export const runLyricsSweep = async (
    ctx: SweepContext,
    server: ServerListItem,
    deps?: Partial<LyricsSweepDeps>,
): Promise<void> => {
    const { db, signal } = ctx;
    const fetchLyrics = deps?.fetchLyrics ?? ((song, sig) => fetchServerLyrics(server, song, sig));
    const now = deps?.now ?? (() => Date.now());
    const actions = useCacheStore.getState().actions;

    const existingMeta = await db.syncMeta.get('lyrics');
    const initialIndex = existingMeta?.nextStartIndex ?? 0;
    let startIndex = initialIndex;

    const ids = (await db.songs.orderBy('Id').primaryKeys()) as string[];
    const total = ids.length;

    actions.setHydrationState('lyrics', 'partial');
    console.info('[cache] sweep:lyrics start', {
        resumeFrom: startIndex,
        serverId: server.id,
        total,
    });

    const sweepStartedAt = now();
    let bytesDownloaded = 0;

    const emit = (): void => {
        const elapsed = (now() - sweepStartedAt) / 1000;
        actions.setSweep({
            entity: 'lyrics',
            progress: {
                bytesDownloaded,
                bytesPerSec: bytesDownloaded / Math.max(1, elapsed),
                done: startIndex,
                estimatedTotalBytes: undefined,
                itemsPerSec: elapsed > 0 ? (startIndex - initialIndex) / elapsed : 0,
                startedAt: sweepStartedAt,
                total,
            },
        });
    };
    emit();

    try {
        while (startIndex < total) {
            if (signal.aborted) {
                console.info('[cache] sweep:lyrics aborted');
                return;
            }
            if (!getIsOnline()) {
                console.info('[cache] sweep:lyrics paused (offline) — checkpoint preserved');
                actions.setSweep(undefined);
                return;
            }

            const chunkIds = ids.slice(startIndex, startIndex + LYRICS_CHUNK);
            const existing = (await db.lyrics.bulkGet(chunkIds)) as Array<CachedLyrics | undefined>;
            const needIds = chunkIds.filter((_, k) => existing[k] === undefined);

            if (needIds.length > 0) {
                const songRows = (await db.songs.bulkGet(needIds)) as Array<CachedSong | undefined>;
                const rows = await runWithConcurrency(
                    songRows,
                    LYRICS_CONCURRENCY,
                    async (songRow): Promise<CachedLyrics | undefined> => {
                        if (!songRow || signal.aborted) return undefined;
                        const result = await fetchLyrics(songRow.Payload, signal);
                        const row = toLyricsRow(songRow.Id, result, now());
                        bytesDownloaded += row.Lyrics.length;
                        return row;
                    },
                );
                const toWrite = rows.filter((r): r is CachedLyrics => r !== undefined);
                if (toWrite.length > 0) await db.lyrics.bulkPut(toWrite);
            }

            startIndex += chunkIds.length;
            const isDone = startIndex >= total;
            await db.syncMeta.put({
                EntityType: 'lyrics',
                hydrationState: isDone ? 'full' : 'partial',
                lastFullSyncAt: isDone ? now() : existingMeta?.lastFullSyncAt,
                lastSweepAt: now(),
                nextStartIndex: isDone ? undefined : startIndex,
                pausedUntil: undefined,
                totalCount: total,
            });
            emit();
        }

        actions.setEntityCount('lyrics', await db.lyrics.count());
        actions.setHydrationState('lyrics', 'full');
        actions.setSweep(undefined);
        console.info('[cache] sweep:lyrics done', { durationMs: now() - sweepStartedAt, total });
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        if (isSweepNetworkError(err)) {
            console.warn('[cache] sweep:lyrics network error — checkpoint preserved', {
                error: (err as Error)?.message,
            });
            actions.setSweep(undefined);
            return;
        }
        throw err;
    }
};
