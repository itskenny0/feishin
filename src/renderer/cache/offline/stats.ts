// Aggregate offline-media stats + availability index, published into the cache
// store so the settings panel, download banner, and green "available offline"
// indicators reflect what's on disk without each polling Dexie. Extracted from
// the old offline-media engine; the manager calls refreshOfflineStats via its
// onChanged hook (wired at the bottom of this module).

import type { LocalMediaStore } from '../media-store';
import type { OfflineTargetStatus } from '../types';

import { localMediaStore, normalizeTargetStatus } from '../media-store';
import { useCacheStore } from '../store';
import { countMissingOfflineSongMeta } from './song-meta';

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
 *
 * `precomputed` lets `refreshOfflineStats` hand over the same key arrays it
 * just fetched for its own ground-truth counts, so a single refresh cycle
 * doesn't scan the `mediaBlobs` key indexes twice. Omit it (the normal case
 * for standalone callers, e.g. lifecycle boot) to fetch fresh.
 */
export const refreshOfflineAvailability = async (
    store: LocalMediaStore = localMediaStore,
    precomputed?: { entityKeys: string[]; songKeys: string[] },
): Promise<void> => {
    try {
        const [songKeys, entityKeys] = precomputed
            ? [precomputed.songKeys, precomputed.entityKeys]
            : await Promise.all([store.listSongKeys(), store.listAvailableEntityKeys()]);
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
 *
 * `itemsDownloaded`/`targetCount` are scoped to the ACTIVE server. `mediaBlobs`
 * and `offlineTargets` are unscoped ground truth across every server this
 * device has ever synced with — a device that reconfigured its Jellyfin
 * connection (or switched servers) mints a new serverId, and any blobs left
 * over from the old one are unreachable dead weight the "Available offline"
 * list (which IS server-scoped — see loadOfflineSongs) can never render. Left
 * unscoped, those orphaned blobs silently inflated the published badge far
 * past what the list could ever show — the "2800 downloaded, 300 in the
 * list" bug. `bytesUsed` intentionally stays global: it tracks real disk
 * usage against the storage cap regardless of which server wrote the bytes.
 */
export const refreshOfflineStats = async (
    store: LocalMediaStore = localMediaStore,
): Promise<void> => {
    let precomputed: undefined | { entityKeys: string[]; songKeys: string[] };
    try {
        const [bytesUsed, allSongKeys, allEntityKeys, targets] = await Promise.all([
            store.totalBytes(),
            store.listSongKeys(),
            store.listAvailableEntityKeys(),
            store.listTargets(),
        ]);
        // Hand the freshly-fetched key arrays to refreshOfflineAvailability
        // below so it doesn't re-scan the same indexes a second time.
        precomputed = { entityKeys: allEntityKeys, songKeys: allSongKeys };

        const activeServerId = useCacheStore.getState().activeServer?.serverId;
        const scopedSongKeys = activeServerId
            ? allSongKeys.filter((key) => key.startsWith(`${activeServerId}:`))
            : allSongKeys;
        const scopedTargets = activeServerId
            ? targets.filter((t) => t.ServerId === activeServerId)
            : targets;

        useCacheStore.getState().actions.setOfflineMedia({
            bytesUsed,
            itemsDownloaded: scopedSongKeys.length,
            targetCount: scopedTargets.length,
        });
        // Status map stays keyed by the FULL `${serverId}:${type}:${id}` key
        // (see targetKey), so it's already unambiguous across servers —
        // publish every target's status, not just the active server's.
        const statuses: Record<string, OfflineTargetStatus> = {};
        for (const target of targets) {
            statuses[target.Key] = normalizeTargetStatus(target.Status);
        }
        useCacheStore.getState().actions.setOfflineTargetStatuses(statuses);

        if (activeServerId && scopedSongKeys.length !== allSongKeys.length) {
            console.info(`${TAG} scoped offline stats to active server`, {
                activeServerId,
                globalSongs: allSongKeys.length,
                scopedSongs: scopedSongKeys.length,
            });
        }

        // Ground-truth self-heal signal: a downloaded blob whose song row is
        // missing from db.songs is exactly what makes loadOfflineSongs render
        // fewer rows than are really on disk (see song-meta.ts). Detection
        // only — the fix requires re-fetching the song's metadata from the
        // server, which belongs to the download pipeline, not this read-only
        // aggregator — but a silent gap here is worse than a loud one.
        const scopedSongIds = scopedSongKeys
            .map((key) => key.slice(key.indexOf(':') + 1))
            .filter(Boolean);
        const missingMeta = await countMissingOfflineSongMeta(scopedSongIds);
        if (missingMeta > 0) {
            console.warn(`${TAG} offline song metadata gap detected`, {
                missingMeta,
                totalDownloaded: scopedSongIds.length,
            });
        }
    } catch (err) {
        console.warn(`${TAG} refreshOfflineStats failed`, err);
    }
    await refreshOfflineAvailability(store, precomputed);
};
