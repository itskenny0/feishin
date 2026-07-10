// Aggregate offline-media stats + availability index, published into the cache
// store so the settings panel, download banner, and green "available offline"
// indicators reflect what's on disk without each polling Dexie. Extracted from
// the old offline-media engine; the manager calls refreshOfflineStats via its
// onChanged hook (wired at the bottom of this module).

import type { LocalMediaStore } from '../media-store';
import type { OfflineTargetStatus } from '../types';

import { localMediaStore, normalizeTargetStatus } from '../media-store';
import { useCacheStore } from '../store';

const TAG = '[offline-media]';

const sameSet = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
};

/**
 * Rebuild the in-memory offline-availability index (downloaded song keys +
 * entity keys with at least one downloaded song) and publish it. Cheap key
 * scans only — no blob bytes are materialised. Skips the store write when
 * membership is unchanged so equality-fn subscribers don't re-render.
 */
export const refreshOfflineAvailability = async (
    store: LocalMediaStore = localMediaStore,
): Promise<void> => {
    try {
        const [songKeys, entityKeys] = await Promise.all([
            store.listSongKeys(),
            store.listAvailableEntityKeys(),
        ]);
        const nextSongs = new Set(songKeys);
        const nextEntities = new Set(entityKeys);
        const prev = useCacheStore.getState().offlineAvailability;
        if (sameSet(prev.songKeys, nextSongs) && sameSet(prev.entityKeys, nextEntities)) {
            return;
        }
        console.info(`${TAG} availability refreshed`, {
            entities: nextEntities.size,
            songs: nextSongs.size,
        });
        useCacheStore.getState().actions.setOfflineAvailability({
            entityKeys: nextEntities,
            songKeys: nextSongs,
        });
    } catch (err) {
        console.warn(`${TAG} refreshOfflineAvailability failed`, err);
    }
};

/**
 * Refresh the aggregate offline-media stats (bytes / items / target count) and
 * the per-target status map from the persisted rows, then keep the availability
 * index in lock-step. Legacy/crash-residue statuses are normalized so the UI
 * shows the live state machine.
 */
export const refreshOfflineStats = async (
    store: LocalMediaStore = localMediaStore,
): Promise<void> => {
    try {
        const [bytesUsed, itemsDownloaded, targets] = await Promise.all([
            store.totalBytes(),
            store.count(),
            store.listTargets(),
        ]);
        useCacheStore.getState().actions.setOfflineMedia({
            bytesUsed,
            itemsDownloaded,
            targetCount: targets.length,
        });
        const statuses: Record<string, OfflineTargetStatus> = {};
        for (const target of targets) {
            statuses[target.Key] = normalizeTargetStatus(target.Status);
        }
        useCacheStore.getState().actions.setOfflineTargetStatuses(statuses);
    } catch (err) {
        console.warn(`${TAG} refreshOfflineStats failed`, err);
    }
    await refreshOfflineAvailability(store);
};
