import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import type { EntityType, HydrationState } from './types';

export interface CacheStoreActions {
    actions: {
        setActiveServer: (s: CacheStoreState['activeServer']) => void;
        setBytesUsed: (n: number | undefined) => void;
        setCacheAvailable: (v: boolean) => void;
        setEntityCount: (e: EntityType, n: number) => void;
        setHydrationState: (e: EntityType, s: HydrationState) => void;
        setOfflineMedia: (s: Partial<OfflineMediaStats>) => void;
        setOfflineSync: (s: CacheStoreState['offlineSync']) => void;
        setPendingMutations: (n: number) => void;
        setSweep: (s: CacheStoreState['sweep']) => void;
    };
}

export interface CacheStoreState {
    activeServer: undefined | { serverId: string; userId: string };
    bytesUsed: number | undefined;
    cacheAvailable: boolean | undefined;
    entityCounts: Partial<Record<EntityType, number>>;
    hydrationStates: Partial<Record<EntityType, HydrationState>>;
    // Aggregate offline-media stats, kept in the store so the settings panel
    // and any future home-page chip can subscribe without each polling Dexie.
    offlineMedia: OfflineMediaStats;
    // Live in-flight offline download (a single target syncs at a time).
    // Undefined when nothing is downloading.
    offlineSync: OfflineSyncProgress | undefined;
    pendingMutations: number;
    sweep: undefined | { entity: EntityType; progress: SweepProgress };
}

export interface OfflineMediaStats {
    // Total downloaded blob bytes across all targets.
    bytesUsed: number;
    // Distinct downloaded songs.
    itemsDownloaded: number;
    // Number of offline targets.
    targetCount: number;
}

export interface OfflineSyncProgress {
    bytesDownloaded: number;
    bytesPerSec: number;
    done: number;
    entityKey: string;
    // Best-effort projected total payload, from the average blob size so far
    // extrapolated across all songs. Undefined until the first blob lands.
    estimatedTotalBytes: number | undefined;
    itemsPerSec: number;
    name: string;
    startedAt: number;
    total: number | undefined;
}

export interface SweepProgress {
    bytesDownloaded: number;
    bytesPerSec: number;
    done: number;
    // Best-effort extrapolation of the final total payload size, computed
    // each page as `bytesDownloaded * (total / done)` once `total` is known.
    // Undefined if `total` is unknown (server returned no total).
    estimatedTotalBytes: number | undefined;
    itemsPerSec: number;
    // 1-indexed page counter for sequential sweeps. Surfaced in the
    // dashboard label so the user sees "page 9/16" advancing even when
    // a slow Jellyfin page makes the items/sec rate look frozen.
    pageIndex?: number;
    pageTotal?: number;
    // Coarse sub-phase the sweep is in right now. `fetching` means a
    // network request is in flight for the next batch and no items are
    // landing in Dexie; `processing` means items just landed and the
    // sweep is about to advance. The dashboard surfaces this so a
    // slow page fetch doesn't look like a stall. Undefined for sweeps
    // that don't have a discrete fetch phase (e.g. the thumbnail
    // worker pool).
    phase?: 'fetching' | 'processing';
    startedAt: number;
    total: number | undefined;
}

export const useCacheStore = createWithEqualityFn<CacheStoreActions & CacheStoreState>()(
    devtools(
        immer((set) => ({
            actions: {
                setActiveServer: (s) =>
                    set((st) => {
                        st.activeServer = s;
                    }),
                setBytesUsed: (n) =>
                    set((st) => {
                        st.bytesUsed = n;
                    }),
                setCacheAvailable: (v) =>
                    set((st) => {
                        st.cacheAvailable = v;
                    }),
                setEntityCount: (e, n) =>
                    set((st) => {
                        st.entityCounts[e] = n;
                    }),
                setHydrationState: (e, s) =>
                    set((st) => {
                        st.hydrationStates[e] = s;
                    }),
                setOfflineMedia: (s) =>
                    set((st) => {
                        st.offlineMedia = { ...st.offlineMedia, ...s };
                    }),
                setOfflineSync: (s) =>
                    set((st) => {
                        st.offlineSync = s;
                    }),
                setPendingMutations: (n) =>
                    set((st) => {
                        st.pendingMutations = n;
                    }),
                setSweep: (s) =>
                    set((st) => {
                        st.sweep = s;
                    }),
            },
            activeServer: undefined,
            bytesUsed: undefined,
            cacheAvailable: undefined,
            entityCounts: {},
            hydrationStates: {},
            offlineMedia: { bytesUsed: 0, itemsDownloaded: 0, targetCount: 0 },
            offlineSync: undefined,
            pendingMutations: 0,
            sweep: undefined,
        })),
        { name: 'cache-store' },
    ),
    shallow,
);

export const useCacheActions = (): CacheStoreActions['actions'] => useCacheStore((s) => s.actions);
