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
    // colon.
    const songIds = blobKeys.map((key) => key.slice(key.indexOf(':') + 1)).filter(Boolean);

    const rows = await db.songs.bulkGet(songIds);
    const songs: Song[] = [];
    for (const row of rows) {
        if (row?.Payload) songs.push(row.Payload);
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
