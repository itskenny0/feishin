// Streaming enumeration of an offline target's songs. Yields songs in PAGES as
// they arrive so the download pool can start on page 1 instead of waiting for
// the whole (potentially huge) playlist to enumerate. Album/song targets
// resolve in a single page; playlist/artist/genre targets page through.
//
// Error policy: a FIRST-page error throws (nothing was enumerated — the target
// fails). A later-page error ends the stream cleanly (the pages already yielded
// remain queued — the target ends `partial`, not `error`). Every server call is
// retried with bounded exponential backoff first, so a transient 502 from an
// overloaded server doesn't fail a wanted target — but a sustained outage still
// surfaces as an error instead of looping forever.

import type { Song } from '/@/shared/types/domain-types';

import type { OfflineTargetRow } from '../types';

import { api } from '/@/renderer/api';
import { SongListSort, SortOrder } from '/@/shared/types/domain-types';

const TAG = '[offline-media]';
const ENUMERATE_PAGE = 500;
const MAX_ATTEMPTS = 3;
// Hard circuit breaker for the playlist/artist/genre paging loop below. A
// well-behaved server always shrinks below ENUMERATE_PAGE eventually, but a
// buggy/pathological one (a cursor that never advances, or a page endpoint
// that keeps re-serving full pages) would otherwise loop forever — and since
// this generator drives processTarget's `for await`, that leaves the target
// stuck in `enumerating` permanently AND deadlocks the queue pump on it (every
// other queued target starves behind a `for await` that never returns). 4000
// pages @ 500/page = 2,000,000 songs, far beyond any real library, so this
// never trips on legitimate content.
const MAX_PAGES = 4000;

// Backoff base; overridable so tests don't wait real seconds.
let retryBaseMs = 1500;
/** Test hook: shorten (or zero) the retry backoff. */
export const setEnumerateRetryBaseMsForTests = (ms: number): void => {
    retryBaseMs = ms;
};

const isAbort = (err: unknown, signal?: AbortSignal): boolean => {
    if (signal?.aborted) return true;
    const name = (err as undefined | { name?: string })?.name;
    const code = (err as undefined | { code?: string })?.code;
    return name === 'AbortError' || name === 'CanceledError' || code === 'ERR_CANCELED';
};

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new DOMException('aborted', 'AbortError'));
            },
            { once: true },
        );
    });

/**
 * Run `fn`, retrying a transient failure (e.g. a 502 from an overloaded server)
 * with exponential backoff. Never retries an abort. Bounded to MAX_ATTEMPTS so a
 * sustained outage rejects instead of looping.
 */
export const withRetry = async <T>(
    fn: () => Promise<T>,
    signal?: AbortSignal,
    label = '',
): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
        try {
            return await fn();
        } catch (err) {
            if (isAbort(err, signal)) throw err;
            lastErr = err;
            if (attempt >= MAX_ATTEMPTS) break;
            const delay = retryBaseMs * 2 ** (attempt - 1);
            console.warn(
                `${TAG} enumerate: ${label} attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying in ${delay}ms`,
                err,
            );
            await sleep(delay, signal);
        }
    }
    throw lastErr;
};

const fetchPage = async (
    entityType: OfflineTargetRow['EntityType'],
    entityId: string,
    apiClientProps: { serverId: string; signal?: AbortSignal },
    startIndex: number,
): Promise<Song[]> => {
    if (entityType === 'playlist') {
        const page = await api.controller.getPlaylistSongList({
            apiClientProps,
            query: { id: entityId, limit: ENUMERATE_PAGE, startIndex },
        });
        return page?.items ?? [];
    }
    const page = await api.controller.getSongList({
        apiClientProps,
        query: {
            albumArtistIds: entityType === 'artist' ? [entityId] : undefined,
            genreIds: entityType === 'genre' ? [entityId] : undefined,
            limit: ENUMERATE_PAGE,
            sortBy: SongListSort.ALBUM,
            sortOrder: SortOrder.ASC,
            startIndex,
        },
    });
    return page?.items ?? [];
};

export async function* streamTargetSongs(
    target: Pick<OfflineTargetRow, 'EntityId' | 'EntityType' | 'ServerId'>,
    signal?: AbortSignal,
): AsyncGenerator<Song[]> {
    const { EntityId: entityId, EntityType: entityType, ServerId: serverId } = target;
    const apiClientProps = { serverId, signal };

    if (entityType === 'album') {
        // Album songs must be enumerated via getAlbumDetail (it uses ParentId
        // semantics; the AlbumIds filter returns a wrong subset on some Jellyfin
        // libraries — see jellyfin-controller getAlbumDetail).
        const album = await withRetry(
            () => api.controller.getAlbumDetail({ apiClientProps, query: { id: entityId } }),
            signal,
            'album',
        );
        const items = album?.songs ?? [];
        if (items.length) yield items;
        return;
    }

    if (entityType === 'song') {
        const song = await withRetry(
            () => api.controller.getSongDetail({ apiClientProps, query: { id: entityId } }),
            signal,
            'song',
        );
        if (song) yield [song];
        return;
    }

    // playlist / artist / genre — page through.
    let startIndex = 0;
    let firstPage = true;
    let pageCount = 0;
    while (true) {
        if (signal?.aborted) return;
        if (pageCount >= MAX_PAGES) {
            // Treated like a later-page error: end the stream cleanly and keep
            // whatever was already yielded (the target settles `partial`, not a
            // stuck `enumerating`). See MAX_PAGES for why this exists.
            console.warn(`${TAG} enumerate: page cap reached, ending stream`, {
                entityId,
                entityType,
                pageCount,
            });
            return;
        }
        let items: Song[];
        try {
            items = await withRetry(
                () => fetchPage(entityType, entityId, apiClientProps, startIndex),
                signal,
                entityType,
            );
        } catch (err) {
            if (firstPage) throw err; // nothing enumerated → target fails
            console.warn(`${TAG} enumerate: page error, ending stream`, {
                entityId,
                err,
                startIndex,
            });
            return; // later page → keep what we have
        }
        firstPage = false;
        pageCount += 1;
        if (items.length) yield items;
        if (items.length < ENUMERATE_PAGE) return;
        startIndex += ENUMERATE_PAGE;
    }
}
