// Adaptive paged fetch — shared safeguard against the "large single request
// hangs on a slow/overloaded server" bug class (a fixed large `Limit`, or an
// unbounded "fetch every song of this entity" call, times out at the proxy
// ~30s → ERR_NETWORK and never completes for a big genre/artist/playlist/album).
//
// It pages through a server list and, on a page-request failure, SHRINKS the
// page size (initial → 100 → floor) and retries the SAME offset — so a large
// entity converges to a page the server can actually return, instead of failing
// forever at one oversized request. This is the generalisation of the offline
// enumeration fix in `cache/offline/enumerate.ts`; use it for playback /
// queue-building and other bulk song fetches.

const TAG = '[paged-fetch]';
const DEFAULT_PAGE = 500;
const DEFAULT_MIN_PAGE = 25;
// 4000 pages @ 500 = 2M items — far beyond any real library; a hard backstop
// against a pathological server (a cursor that never advances) looping forever.
const DEFAULT_MAX_PAGES = 4000;
// At the floor size, ride out a transient blip a couple of times before giving
// up (the shrink is the primary resilience; this covers a flaky-but-small page).
const MAX_FLOOR_RETRIES = 2;
const FLOOR_RETRY_BASE_MS = 1000;

let floorRetryBaseMs = FLOOR_RETRY_BASE_MS;
/** Test hook: shorten (or zero) the floor-retry backoff. */
export const setPagedFetchRetryBaseMsForTests = (ms: number): void => {
    floorRetryBaseMs = ms;
};

const isAbortError = (err: unknown, signal?: AbortSignal): boolean => {
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

export interface AdaptivePageOptions {
    // Initial page size, halved-ish on failure. Default 500.
    initialPage?: number;
    // Tag for logs so a stall is attributable to a call site. Default ''.
    label?: string;
    // Hard cap on page count (pathological-server backstop). Default 4000.
    maxPages?: number;
    // Smallest page size we'll try before giving up. Default 25.
    minPage?: number;
    // Abort signal — a rejected/aborted fetch ends the stream cleanly.
    signal?: AbortSignal;
}

/**
 * Collect every page into a single array via {@link streamAdaptivePaged}. Use
 * for callers that need the full list before acting (queue-building, migration).
 */
export async function collectAdaptivePaged<T>(
    fetchPage: (startIndex: number, limit: number) => Promise<T[]>,
    opts: AdaptivePageOptions = {},
): Promise<T[]> {
    const out: T[] = [];
    for await (const page of streamAdaptivePaged(fetchPage, opts)) out.push(...page);
    return out;
}

/**
 * Yield pages of items, adaptively shrinking the page size (initialPage → 100 →
 * minPage) and retrying the SAME offset when a page request fails on a slow /
 * overloaded server. A short page ends the stream. A first-page failure at the
 * floor throws (nothing was fetched — the caller decides how to surface it); a
 * later-page failure ends cleanly with whatever was already yielded.
 *
 * `fetchPage(startIndex, limit)` must request exactly `limit` items starting at
 * `startIndex` and return that page's items (fewer than `limit` ⇒ last page).
 */
export async function* streamAdaptivePaged<T>(
    fetchPage: (startIndex: number, limit: number) => Promise<T[]>,
    opts: AdaptivePageOptions = {},
): AsyncGenerator<T[]> {
    const initialPage = opts.initialPage ?? DEFAULT_PAGE;
    const minPage = opts.minPage ?? DEFAULT_MIN_PAGE;
    const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
    const { label = '', signal } = opts;

    let startIndex = 0;
    let pageSize = initialPage;
    let firstPage = true;
    let pageCount = 0;
    let floorRetries = 0;
    while (true) {
        if (signal?.aborted) return;
        if (pageCount >= maxPages) {
            console.warn(`${TAG} ${label} page cap reached, ending stream`, { pageCount });
            return;
        }
        let items: T[];
        try {
            items = await fetchPage(startIndex, pageSize);
        } catch (err) {
            if (isAbortError(err, signal)) return;
            if (pageSize > minPage) {
                // Aggressive first shrink (a 500 timeout means the server needs a
                // much smaller query), then straight to the floor.
                pageSize = pageSize > 100 ? 100 : minPage;
                console.warn(
                    `${TAG} ${label} page failed — shrinking to ${pageSize}, retrying offset ${startIndex}`,
                    err,
                );
                continue;
            }
            if (floorRetries < MAX_FLOOR_RETRIES) {
                floorRetries += 1;
                await sleep(floorRetryBaseMs * floorRetries, signal);
                continue; // transient blip at the floor — retry the same offset
            }
            if (firstPage) throw err; // nothing fetched even at the floor → surface it
            console.warn(`${TAG} ${label} page error at min size, ending stream`, {
                err,
                startIndex,
            });
            return; // later page → keep what we have
        }
        firstPage = false;
        floorRetries = 0;
        pageCount += 1;
        if (items.length) yield items;
        // A response LARGER than the requested page means the backend ignored
        // `limit` and handed back the whole list (e.g. Subsonic's getPlaylist, or
        // any endpoint with no server-side paging). There is nothing more to
        // page, and advancing the offset would just re-fetch the same full list
        // forever — stop here. (Callers reading a cache that ignores `startIndex`
        // add their own non-advance guard for the exact-multiple case this can't
        // see by length alone.)
        if (items.length > pageSize) return;
        if (items.length < pageSize) return;
        startIndex += items.length;
    }
}
