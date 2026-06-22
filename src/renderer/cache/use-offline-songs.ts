// use-offline-songs — loads the song metadata for every track the user has
// downloaded for offline playback. The offline blob store (`mediaBlobs`) keys
// each downloaded blob by `${serverId}:${songId}`; the full `Song` payload for
// each lives in the cached `songs` table. This hook joins the two so the
// "Available offline" library view can render a normal song table backed
// entirely by what's on disk.
//
// `useOfflineSongCount` is the cheap reactive driver for the hide/show of the
// "Available offline" My Library entry — it reads the aggregate count already
// maintained in the cache store (refreshOfflineStats), so it updates as
// downloads complete or are removed without touching Dexie per render.

import type { Song } from '/@/shared/types/domain-types';

import { useQuery } from '@tanstack/react-query';

import { getActiveCacheDb } from './db';
import { localMediaStore } from './media-store';
import { useCacheStore } from './store';

const TAG = '[offline-songs]';

/**
 * Reactive count of distinct downloaded songs. Drives the hidden-when-empty
 * behaviour of the "Available offline" My Library entry: zero → hide, > 0 →
 * show. Backed by the aggregate the offline-media pipeline keeps fresh in the
 * cache store (refreshOfflineStats), so it tracks downloads/removals live.
 */
export const useOfflineSongCount = (): number =>
    useCacheStore((s) => s.offlineMedia.itemsDownloaded);

/**
 * Load the `Song` payloads for every offline-downloaded track in the active
 * cache DB. Walks the downloaded blob keys, extracts their song ids, then bulk-
 * reads the cached song rows. Songs whose metadata row is missing from cache
 * are skipped (the blob is still playable, but we have nothing to render).
 */
export const loadOfflineSongs = async (): Promise<Song[]> => {
    const db = getActiveCacheDb();
    if (!db) return [];

    // Every downloaded blob's `${serverId}:${songId}` key. Cheap key scan.
    const blobKeys = await localMediaStore.listSongKeys();
    if (blobKeys.length === 0) return [];

    // The blob key is `${serverId}:${songId}`. serverId itself can't contain a
    // colon (it's a generated id), so the songId is everything after the first
    // colon. Keep only the ACTIVE server's blobs: the songs table we resolve
    // against is server-scoped, so a blob downloaded under another server
    // would either be skipped or — worse, on coincidentally equal song ids —
    // resolve a different server's song.
    const activeServerId = useCacheStore.getState().activeServer?.serverId;
    const songIds = blobKeys
        .filter((key) => !activeServerId || key.startsWith(`${activeServerId}:`))
        .map((key) => key.slice(key.indexOf(':') + 1))
        .filter(Boolean);
    if (songIds.length === 0) return [];

    // Chunk the bulkGet + yield between batches. A single bulkGet of thousands
    // of ids does ONE atomic main-thread structured-clone of every large nested
    // Song Payload — that was the ~10s freeze before the list could paint.
    // Batching with a macrotask yield lets the route's skeleton paint and keeps
    // the UI responsive while the rows stream in.
    const BATCH = 300;
    const songs: Song[] = [];
    for (let i = 0; i < songIds.length; i += BATCH) {
        const rows = await db.songs.bulkGet(songIds.slice(i, i + BATCH));
        for (const row of rows) {
            if (row?.Payload) songs.push(row.Payload);
        }
        if (i + BATCH < songIds.length) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }
    console.info(`${TAG} loaded offline songs`, { blobs: blobKeys.length, resolved: songs.length });
    return songs;
};

/**
 * React-query wrapper around `loadOfflineSongs`. Keyed by the live offline song
 * count so the list re-fetches when a download lands or is removed.
 */
export const useOfflineSongs = () => {
    const count = useOfflineSongCount();
    return useQuery({
        queryFn: loadOfflineSongs,
        queryKey: ['offline-songs', count],
    });
};
