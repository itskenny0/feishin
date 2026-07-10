// Back-compat shim. The offline-download engine now lives in ./offline/*.
// These re-exports keep the historical import paths working while callers
// migrate to the manager's free-function API (./offline).

import type { Song } from '/@/shared/types/domain-types';

import type { OfflineTargetRow } from './types';

import { streamTargetSongs } from './offline/enumerate';
import { offlineManager } from './offline/manager';

export { refreshOfflineAvailability, refreshOfflineStats } from './offline/stats';

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
    void offlineManager.pauseActive();
};

/** Drain the streaming enumerator into a flat array (legacy callers/tests). */
export const enumerateTargetSongs = async (
    target: Pick<OfflineTargetRow, 'EntityId' | 'EntityType' | 'ServerId'>,
    signal?: AbortSignal,
): Promise<Song[]> => {
    const out: Song[] = [];
    for await (const page of streamTargetSongs(target, signal)) out.push(...page);
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
