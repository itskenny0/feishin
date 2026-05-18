import { get as idbGet, set as idbSet } from 'idb-keyval';

import { TRACKMAP_DATA_VERSION, type TrackmapData } from '/@/renderer/features/trackmap/types';

// Cache key includes sensitivity so changing the knob produces a different
// entry (stale entries are evicted lazily by an LRU layer — a v2 follow-up).
// The `v1` namespace lets us invalidate the whole cache in one shot by
// bumping it if the algorithm output shape ever changes.
const buildKey = (serverId: string, songId: string, sensitivity: number): string =>
    `trackmap:v1:${serverId}:${songId}:s${sensitivity}`;

export const trackmapCache = {
    get: async (
        serverId: string,
        songId: string,
        sensitivity: number,
    ): Promise<null | TrackmapData> => {
        try {
            const stored = await idbGet<TrackmapData>(buildKey(serverId, songId, sensitivity));
            if (!stored) return null;
            // Defensive: if the stored version doesn't match, treat as miss.
            if (stored.version !== TRACKMAP_DATA_VERSION) return null;
            if (!(stored.bins instanceof Float32Array)) return null;
            return stored;
        } catch (err) {
            console.warn('[trackmap] cache.get failed', err);
            return null;
        }
    },

    set: async (
        serverId: string,
        songId: string,
        sensitivity: number,
        data: TrackmapData,
    ): Promise<void> => {
        try {
            await idbSet(buildKey(serverId, songId, sensitivity), data);
        } catch (err) {
            // Quota exceeded, private browsing, IDB unavailable — silent.
            console.warn('[trackmap] cache.set failed', err);
        }
    },
};
