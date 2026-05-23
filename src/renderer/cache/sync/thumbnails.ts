// Thumbnail pre-cache sweep. Iterates every album / artist / playlist row
// in Dexie and fetches its thumbnail blob at the user-configured set of
// sizes via `resolveThumbnail`. The same Dexie `thumbnails` table that
// the lazy `<BaseImage>` path writes to is reused, so subsequent mounts
// hit the cache regardless of whether the pre-cache or the lazy path
// landed the row first.
//
// The sweep is explicitly opt-in: the user picks which `imageRes` size
// buckets to pre-cache via Settings -> Library sync. With no sizes picked
// the sweep is a no-op and we leave the lazy fetch unchanged.

import type { ServerListItem } from '/@/shared/types/domain-types';

import { api } from '/@/renderer/api';
import { getActiveCacheDb } from '/@/renderer/cache/db';
import { resolveThumbnail } from '/@/renderer/cache/images';
import { useCacheStore } from '/@/renderer/cache/store';
import { useSettingsStore } from '/@/renderer/store';
import { LibraryItem } from '/@/shared/types/domain-types';

// Concurrency cap on the parallel thumbnail fetches. Higher numbers
// finish faster but flood the network and the worker thread.
const CONCURRENCY = 6;

type EntityKind = 'album' | 'artist' | 'playlist';

interface PendingThumbnail {
    itemId: string;
    itemType: LibraryItem;
    kind: EntityKind;
    size: number;
}

/**
 * Collect the (id, type, size) triples we want to fetch. Reads each
 * Dexie table once and crosses each row with each selected size bucket.
 * Returns the resolved size from `general.imageRes` so the caller can
 * just call `api.controller.getImageUrl` and `resolveThumbnail`.
 */
const collectPending = async (
    sizes: number[],
): Promise<PendingThumbnail[]> => {
    const db = getActiveCacheDb();
    if (!db) return [];
    const out: PendingThumbnail[] = [];

    const albums = await db.albums.toArray();
    for (const row of albums) {
        if (!row.Payload?.imageId && !row.Payload?.id) continue;
        for (const size of sizes) {
            out.push({
                itemId: row.Id,
                itemType: LibraryItem.ALBUM,
                kind: 'album',
                size,
            });
        }
    }

    const artists = await db.artists.toArray();
    for (const row of artists) {
        if (!row.Payload?.id) continue;
        for (const size of sizes) {
            out.push({
                itemId: row.Id,
                itemType: LibraryItem.ALBUM_ARTIST,
                kind: 'artist',
                size,
            });
        }
    }

    const playlists = await db.playlists.toArray();
    for (const row of playlists) {
        if (!row.Payload?.id) continue;
        for (const size of sizes) {
            out.push({
                itemId: row.Id,
                itemType: LibraryItem.PLAYLIST,
                kind: 'playlist',
                size,
            });
        }
    }

    return out;
};

/**
 * Run one thumbnail fetch through the shared resolver. The resolver
 * dedups in-flight requests, checks the existing Dexie row, and writes
 * back to the table on miss — we don't have to do any of that here.
 */
const fetchOne = async (
    pending: PendingThumbnail,
    serverId: string,
): Promise<number> => {
    const url = api.controller.getImageUrl({
        apiClientProps: { serverId },
        query: { id: pending.itemId, itemType: pending.itemType, size: pending.size },
    });
    if (!url) return 0;
    const db = getActiveCacheDb();
    if (!db) return 0;

    // Skip if the row already exists — saves a redundant network call
    // when the user has been browsing while the sweep is in flight.
    const existing = await db.thumbnails.get([pending.itemId, pending.size]);
    if (existing) return 0;

    const before = Date.now();
    await resolveThumbnail(pending.itemId, pending.size, url);
    return Math.max(0, Date.now() - before);
};

/**
 * Run the thumbnail pre-cache sweep for the given server. No-op when
 * the user hasn't picked any thumbnail sizes.
 */
export const runThumbnailsSweep = async (
    args: { signal: AbortSignal },
    server: ServerListItem,
): Promise<void> => {
    const { signal } = args;
    const localCache = useSettingsStore.getState().localCache;
    const general = useSettingsStore.getState().general;
    const buckets = localCache?.thumbnailSizes ?? [];
    if (buckets.length === 0) {
        console.info('[cache] thumbnails sweep: no sizes selected, skipping');
        return;
    }

    const sizes = buckets
        .map((b) => general.imageRes[b])
        .filter((n): n is number => typeof n === 'number' && n > 0);
    if (sizes.length === 0) {
        console.warn('[cache] thumbnails sweep: configured buckets resolved to no sizes');
        return;
    }

    const pending = await collectPending(sizes);
    const total = pending.length;
    if (total === 0) {
        console.info('[cache] thumbnails sweep: no items to pre-cache yet');
        return;
    }

    console.info('[cache] thumbnails sweep: starting', {
        items: total,
        serverId: server.id,
        sizes,
    });

    const actions = useCacheStore.getState().actions;
    const startedAt = Date.now();
    let done = 0;

    actions.setSweep({
        entity: 'thumbnails',
        progress: {
            bytesDownloaded: 0,
            bytesPerSec: 0,
            done: 0,
            estimatedTotalBytes: undefined,
            itemsPerSec: 0,
            startedAt,
            total,
        },
    });

    // Simple bounded-concurrency worker pool.
    const queue = pending.slice();
    const workers: Promise<void>[] = [];

    const work = async (): Promise<void> => {
        while (queue.length > 0) {
            if (signal.aborted) return;
            const next = queue.shift();
            if (!next) return;
            try {
                await fetchOne(next, server.id);
            } catch (err) {
                console.warn('[cache] thumbnails sweep: fetch failed', {
                    err: (err as Error).message,
                    item: next.itemId,
                });
            }
            done += 1;
            const elapsed = Math.max(1, (Date.now() - startedAt) / 1000);
            actions.setSweep({
                entity: 'thumbnails',
                progress: {
                    bytesDownloaded: 0,
                    bytesPerSec: 0,
                    done,
                    estimatedTotalBytes: undefined,
                    itemsPerSec: done / elapsed,
                    startedAt,
                    total,
                },
            });
        }
    };

    for (let i = 0; i < CONCURRENCY; i += 1) {
        workers.push(work());
    }

    await Promise.all(workers);

    if (signal.aborted) {
        console.warn('[cache] thumbnails sweep: aborted', { done, total });
        return;
    }

    console.info('[cache] thumbnails sweep: complete', {
        durationMs: Date.now() - startedAt,
        items: total,
    });
};
