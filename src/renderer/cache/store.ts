import { devtools } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';
import { createWithEqualityFn } from 'zustand/traditional';

import type { EntityType, HydrationState, OfflineTargetStatus } from './types';

export interface CacheStoreActions {
    actions: {
        setActiveServer: (s: CacheStoreState['activeServer']) => void;
        setBytesUsed: (n: number | undefined) => void;
        setCacheAvailable: (v: boolean) => void;
        setEntityCount: (e: EntityType, n: number) => void;
        setHydrationState: (e: EntityType, s: HydrationState) => void;
        setOfflineAvailability: (a: OfflineAvailability) => void;
        setOfflineMedia: (s: Partial<OfflineMediaStats>) => void;
        setOfflineSync: (s: CacheStoreState['offlineSync']) => void;
        setOfflineTargetStatus: (key: string, status: OfflineTargetStatus) => void;
        setOfflineTargetStatuses: (statuses: Record<string, OfflineTargetStatus>) => void;
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
    // Snapshot of which entities/songs are downloaded for offline playback.
    // Held in memory so list/detail surfaces can render the "available
    // offline" indicator without each row hitting Dexie. Refreshed by the
    // offline-media subsystem whenever a download finishes or a target is
    // removed (see refreshOfflineAvailability).
    offlineAvailability: OfflineAvailability;
    // Aggregate offline-media stats, kept in the store so the settings panel
    // and any future home-page chip can subscribe without each polling Dexie.
    offlineMedia: OfflineMediaStats;
    // Live in-flight offline download (a single target syncs at a time).
    // Undefined when nothing is downloading.
    offlineSync: OfflineSyncProgress | undefined;
    // Per-target download status (`${serverId}:${entityType}:${entityId}` →
    // idle/syncing/partial/complete/error) so download buttons render
    // spinner / checkmark states without each hitting Dexie. Seeded from the
    // targets table on stats refresh; live transitions mirrored by the
    // offline-media sync pipeline.
    offlineTargetStatuses: Record<string, OfflineTargetStatus>;
    pendingMutations: number;
    sweep: undefined | { entity: EntityType; progress: SweepProgress };
}

/**
 * In-memory index of what's available offline. `entityKeys` holds the
 * `${serverId}:${entityType}:${entityId}` key of every offline target that
 * has at least one downloaded song (so a partially-downloaded album still
 * reads as "available"). `songKeys` holds every downloaded blob's
 * `${serverId}:${songId}` key. Both are plain Sets — identity changes on
 * each refresh so equality-fn subscribers re-render only when membership
 * actually changes (see refreshOfflineAvailability, which skips the set
 * when nothing changed).
 */
export interface OfflineAvailability {
    entityKeys: Set<string>;
    songKeys: Set<string>;
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
    // Set to 'offline' while the sweep is parked waiting for connectivity to
    // return (network-status reported the link/server down). The cursor is
    // preserved; the sweep resumes from the exact same position once online.
    // The dashboard surfaces this as "paused (offline)" so a deliberate pause
    // doesn't look like a stall. Undefined while the sweep is actively making
    // (or attempting) progress.
    paused?: 'offline';
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
                setOfflineAvailability: (a) =>
                    set((st) => {
                        st.offlineAvailability = a;
                    }),
                setOfflineMedia: (s) =>
                    set((st) => {
                        st.offlineMedia = { ...st.offlineMedia, ...s };
                    }),
                setOfflineSync: (s) =>
                    set((st) => {
                        st.offlineSync = s;
                    }),
                setOfflineTargetStatus: (key, status) =>
                    set((st) => {
                        st.offlineTargetStatuses[key] = status;
                    }),
                setOfflineTargetStatuses: (statuses) =>
                    set((st) => {
                        st.offlineTargetStatuses = statuses;
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
            offlineAvailability: { entityKeys: new Set(), songKeys: new Set() },
            offlineMedia: { bytesUsed: 0, itemsDownloaded: 0, targetCount: 0 },
            offlineSync: undefined,
            offlineTargetStatuses: {},
            pendingMutations: 0,
            sweep: undefined,
        })),
        { name: 'cache-store' },
    ),
    shallow,
);

export const useCacheActions = (): CacheStoreActions['actions'] => useCacheStore((s) => s.actions);
