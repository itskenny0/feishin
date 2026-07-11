// Thin writers that publish offline-download progress into the cache store.
// Kept separate from the manager so the manager stays focused on orchestration.

import type { OfflineQueueSummary, OfflineSyncProgress } from '../store';

import { useCacheStore } from '../store';

const TAG = '[offline-media]';

export const publishProgress = (p: OfflineSyncProgress | undefined): void => {
    try {
        // Ground-truth sanity check only — never clamp/mutate what the caller
        // computed (that would mask the real bug and could disagree with
        // exact-value assertions elsewhere); just make a `done > total` drift
        // impossible to miss in the logs.
        if (p && p.total !== undefined && p.done > p.total) {
            console.warn(`${TAG} progress done exceeds total`, {
                done: p.done,
                entityKey: p.entityKey,
                total: p.total,
            });
        }
        useCacheStore.getState().actions.setOfflineSync(p);
    } catch (err) {
        console.warn(`${TAG} publishProgress failed`, err);
    }
};

export const publishQueue = (q: OfflineQueueSummary | undefined): void => {
    try {
        if (q && q.targetsDone > q.targetsTotal) {
            console.warn(`${TAG} queue targetsDone exceeds targetsTotal`, {
                targetsDone: q.targetsDone,
                targetsTotal: q.targetsTotal,
            });
        }
        useCacheStore.getState().actions.setOfflineQueue(q);
    } catch (err) {
        console.warn(`${TAG} publishQueue failed`, err);
    }
};
