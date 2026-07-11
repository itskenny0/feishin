// Back-compat shim. The offline-download engine now lives in ./offline/*.
// These re-exports keep the historical import paths working while callers
// migrate to the manager's free-function API (./offline).

import type { Song } from '/@/shared/types/domain-types';

import type { OfflineTargetRow } from './types';

import { streamTargetSongs } from './offline/enumerate';
import { offlineManager } from './offline/manager';

export { refreshOfflineAvailability, refreshOfflineStats } from './offline/stats';

const TAG = '[offline-media]';

export interface AddTargetArgs {
    entityId: string;
    entityType: OfflineTargetRow['EntityType'];
    name: string;
    serverId: string;
}

export interface SyncTargetArgs {
    target: OfflineTargetRow;
}

/** Whether the download queue is currently running. */
export const isSyncing = (): boolean => offlineManager.isRunning();

/** Pause whichever target is downloading right now (the old "cancel" button). */
export const cancelOfflineSync = (): void => {
    // Fire-and-forget from the UI's perspective, but a bare `void` on a
    // rejecting promise is an unhandled rejection — catch it here so a
    // transient Dexie write failure logs instead of surfacing as a crash.
    void offlineManager.pauseActive().catch((err) => {
        console.warn(`${TAG} cancelOfflineSync failed`, err);
    });
};

/** Drain the streaming enumerator into a flat array (legacy callers/tests). */
export const enumerateTargetSongs = async (
    target: Pick<OfflineTargetRow, 'EntityId' | 'EntityType' | 'ServerId'>,
    signal?: AbortSignal,
): Promise<Song[]> => {
    const out: Song[] = [];
    try {
        for await (const page of streamTargetSongs(target, signal)) out.push(...page);
    } catch (err) {
        console.warn(`${TAG} enumerateTargetSongs failed`, { err, target: target.EntityId });
        throw err;
    }
    return out;
};

export const addOfflineTarget = (args: AddTargetArgs): Promise<OfflineTargetRow> =>
    offlineManager.enqueue(args);

export const addAndSyncOfflineTarget = (args: AddTargetArgs): Promise<OfflineTargetRow> =>
    offlineManager.enqueue(args);

export const syncTarget = (args: SyncTargetArgs): Promise<OfflineTargetRow> =>
    offlineManager.enqueue({
        entityId: args.target.EntityId,
        entityType: args.target.EntityType,
        name: args.target.Name,
        serverId: args.target.ServerId,
    });

export const syncAllTargets = (): Promise<void> => offlineManager.syncAll();

export const removeOfflineTarget = (key: string): Promise<void> => offlineManager.remove(key);

export const removeAllTargets = (): Promise<void> => offlineManager.removeAll();
