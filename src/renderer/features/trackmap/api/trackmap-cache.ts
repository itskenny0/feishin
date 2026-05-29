import { getCachedTrackmap, putCachedTrackmap } from '/@/renderer/cache/trackmap-cache';
import { TRACKMAP_DATA_VERSION, type TrackmapData } from '/@/renderer/features/trackmap/types';

// Trackmap analyses are persisted in the shared Dexie cache subsystem (the
// `trackmaps` table, db v10) rather than a standalone idb-keyval store. This
// gives them the same opt-in gate (localCache.enabled), per-server+user DB
// scoping, size cap, and LRU eviction as every other cached entity.
//
// CRITICAL: analyses are generated ONLY lazily — the first time a song is
// actually played/visualised (see `analyzeSong`) — never pre-generated during
// the library sync sweep. This module is just the storage adapter for that
// lazy result; it adds nothing to the sweep.
//
// `serverId` is accepted for API stability but is intentionally unused for the
// key: the cache DB is already scoped per (serverId, userId), so the song id
// alone is unambiguous within a single DB. The cache row's compound primary
// key carries the sensitivity + format version so changing the sensitivity
// knob or bumping TRACKMAP_DATA_VERSION naturally misses (forcing re-analysis)
// rather than serving a stale-shaped blob.

export const trackmapCache = {
    get: async (
        _serverId: string,
        songId: string,
        sensitivity: number,
    ): Promise<null | TrackmapData> => {
        const hit = await getCachedTrackmap(songId, sensitivity, TRACKMAP_DATA_VERSION);
        if (!hit) return null;
        return {
            bins: hit.bins,
            computedAt: hit.computedAt,
            durationMs: hit.durationMs,
            version: hit.version,
        };
    },

    set: async (
        _serverId: string,
        songId: string,
        sensitivity: number,
        data: TrackmapData,
    ): Promise<void> => {
        await putCachedTrackmap(songId, sensitivity, {
            bins: data.bins,
            computedAt: data.computedAt,
            durationMs: data.durationMs,
            version: data.version,
        });
    },
};
