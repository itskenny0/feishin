// Sync-first revalidation policy
// ------------------------------
// When the local library cache is the source of truth — the user opted in
// (`localCache.enabled === true`) AND the cache subsystem is up
// (`cacheAvailable === true`) — list / detail / count surfaces render from
// Dexie + the snapshot map WITHOUT firing the automatic background network
// revalidate that the SWR helpers and the list loaders used to kick off
// after every cache hit. In that mode the sync sweep
// (src/renderer/cache/sync/) is the ONLY thing talking to the server for
// library data.
//
// The cold path is untouched: when the cache cannot answer (fromCache /
// localFetchPage returns undefined) every caller still falls through to the
// network exactly as before. Sync-first only suppresses the redundant
// revalidate AFTER a local hit.
//
// Manual refresh (the list refresh button, mobile pull-to-refresh) calls
// `prepareExplicitRefresh`, which opens a short "explicit refresh window"
// during which revalidates are allowed again — a deliberate user action
// always reaches the server even while sync-first is active. The helper
// also drops the sorted-LRU row cache and the snapshot entries for the
// refreshed entity so the fresh server pages actually land.

import type { QueryKey } from '@tanstack/react-query';

import { markRowCacheDirty, markRowsChanged } from './local-cache';
import { dropSnapshotsForEntity } from './snapshot';
import { useCacheStore } from './store';

import { useSettingsStore } from '/@/renderer/store/settings.store';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

export type ExplicitRefreshEntity =
    | 'albumArtists'
    | 'albums'
    | 'all'
    | 'artists'
    | 'genres'
    | 'playlists'
    | 'songs';

const SNAPSHOT_ENTITIES = [
    'albumArtists',
    'albums',
    'artists',
    'genres',
    'playlists',
    'songs',
] as const;

// How long an explicit refresh keeps the network path open. Long enough to
// cover the invalidate → refetch → cache-hit → revalidate round of every
// surface the refresh touches (plus the adjacent-page prefetches a list
// loader fires right after), short enough that sync-first re-engages once
// the user goes back to browsing.
const EXPLICIT_REFRESH_WINDOW_MS = 15_000;

let explicitRefreshUntil = 0;

export const beginExplicitRefreshWindow = (): void => {
    explicitRefreshUntil = Date.now() + EXPLICIT_REFRESH_WINDOW_MS;
};

export const isExplicitRefreshWindowActive = (): boolean => Date.now() < explicitRefreshUntil;

/**
 * True when the sync-first policy applies: the user enabled the local
 * cache AND the subsystem probe succeeded. Both read synchronously so the
 * predicate is safe inside queryFn hot paths.
 */
export const isSyncFirstActive = (): boolean =>
    useSettingsStore.getState().localCache?.enabled === true &&
    useCacheStore.getState().cacheAvailable === true;

// Sample-rate the suppression log so a busy infinite scroll doesn't spam
// devtools — one line per 50 suppressed revalidates is plenty to confirm
// the policy is engaged.
let suppressCounter = 0;

/**
 * THE shared gate for every background-revalidate call site. Returns true
 * when the automatic revalidate should still fire (cache disabled / cold /
 * explicit refresh in flight), false when sync-first applies and the sweep
 * owns freshness. Call sites only consult this AFTER a cache hit — the
 * network fallback for cache misses must never be gated through it.
 */
export const shouldRevalidateFromNetwork = (): boolean => {
    if (isExplicitRefreshWindowActive()) return true;
    if (!isSyncFirstActive()) return true;
    suppressCounter += 1;
    if (suppressCounter % 50 === 1) {
        console.info('[cache] sync-first: suppressed background revalidate (sampled 1/50)');
    }
    return false;
};

// Per-queryKey throttle for background revalidates (moved here from
// hooks.ts so `prepareExplicitRefresh` can clear it without an import
// cycle). After a successful consume we record the timestamp and skip
// subsequent revalidates for the same queryKey within REVALIDATE_TTL_MS —
// this stops large-album / large-playlist surfaces from refetching the
// entire payload every time the user navigates to them within a session.
const lastRevalidateAt = new Map<string, number>();
const REVALIDATE_TTL_MS = 60_000;

export const consumeRevalidateThrottle = (queryKey: QueryKey): boolean => {
    const now = Date.now();
    // Lazy TTL prune. Entries older than the TTL can never gate again —
    // they'd pass the freshness check below regardless — so dropping them
    // here is semantically free and bounds the map to "queryKeys
    // revalidated within the last TTL".
    for (const [k, ts] of lastRevalidateAt) {
        if (now - ts > REVALIDATE_TTL_MS) lastRevalidateAt.delete(k);
    }
    const hash = JSON.stringify(queryKey);
    const last = lastRevalidateAt.get(hash) ?? 0;
    if (now - last < REVALIDATE_TTL_MS) return false;
    lastRevalidateAt.set(hash, now);
    return true;
};

export const clearRevalidateThrottle = (): void => {
    lastRevalidateAt.clear();
};

/**
 * Open the explicit-refresh network window and drop the per-entity caches
 * so the fresh server pages land visibly:
 *  - sorted-LRU + whole-table row cache (`markRowsChanged` /
 *    `markRowCacheDirty`)
 *  - snapshot-map entries for the entity's query keys
 *  - the per-queryKey revalidate throttle (a manual refresh must never be
 *    swallowed by the 60s TTL)
 *
 * Pass no entity for surfaces that aren't backed by the library cache
 * (radio, folders): only the window opens, nothing is dropped.
 */
export const prepareExplicitRefresh = (entity?: ExplicitRefreshEntity): void => {
    beginExplicitRefreshWindow();
    clearRevalidateThrottle();

    if (entity === 'all') {
        markRowsChanged('all');
        for (const e of SNAPSHOT_ENTITIES) dropSnapshotsForEntity(e);
    } else if (entity === 'albumArtists') {
        markRowCacheDirty('albumArtists');
        dropSnapshotsForEntity(entity);
    } else if (entity === 'genres') {
        // Genres have no row-cache slot (the grid reads db.genres directly);
        // dropping the snapshots is all that's needed.
        dropSnapshotsForEntity(entity);
    } else if (entity !== undefined) {
        markRowsChanged(entity);
        dropSnapshotsForEntity(entity);
    }

    console.info('[cache] explicit refresh: forcing network', { entity: entity ?? 'none' });
};

/**
 * Map a list surface's LibraryItem onto the cache entity its explicit
 * refresh should drop. Returns undefined for item types the library cache
 * doesn't back.
 */
export const entityForLibraryItem = (itemType: LibraryItem): ExplicitRefreshEntity | undefined => {
    switch (itemType) {
        case LibraryItem.ALBUM:
            return 'albums';
        case LibraryItem.ALBUM_ARTIST:
            return 'albumArtists';
        case LibraryItem.ARTIST:
            return 'artists';
        case LibraryItem.GENRE:
            return 'genres';
        case LibraryItem.PLAYLIST:
            return 'playlists';
        case LibraryItem.SONG:
            return 'songs';
        default:
            return undefined;
    }
};

/**
 * Same mapping for the `ItemListKey` strings the refresh button / refresh
 * events carry. Sub-lists (e.g. "albums of this artist") map onto the
 * entity whose rows they render.
 */
export const entityForListKey = (listKey: string): ExplicitRefreshEntity | undefined => {
    switch (listKey as ItemListKey) {
        case ItemListKey.ALBUM:
        case ItemListKey.ALBUM_ARTIST_ALBUM:
        case ItemListKey.ALBUM_DETAIL:
        case ItemListKey.GENRE_ALBUM:
        case ItemListKey.PLAYLIST_ALBUM:
            return 'albums';
        case ItemListKey.ALBUM_ARTIST:
            return 'albumArtists';
        case ItemListKey.ALBUM_ARTIST_SONG:
        case ItemListKey.FULL_SCREEN:
        case ItemListKey.GENRE_SONG:
        case ItemListKey.PLAYLIST_SONG:
        case ItemListKey.QUEUE_SONG:
        case ItemListKey.SIDE_QUEUE:
        case ItemListKey.SONG:
            return 'songs';
        case ItemListKey.ARTIST:
            return 'artists';
        case ItemListKey.GENRE:
            return 'genres';
        case ItemListKey.PLAYLIST:
            return 'playlists';
        default:
            return undefined;
    }
};

// Test seam: drop every piece of module state so suites can't leak the
// explicit window / throttle into each other.
export const resetSyncFirstStateForTests = (): void => {
    explicitRefreshUntil = 0;
    lastRevalidateAt.clear();
    suppressCounter = 0;
};
