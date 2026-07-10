// Thin writers that publish offline-download progress into the cache store.
// Kept separate from the manager so the manager stays focused on orchestration.

import type { OfflineQueueSummary, OfflineSyncProgress } from '../store';

import { useCacheStore } from '../store';

export const publishProgress = (p: OfflineSyncProgress | undefined): void => {
    useCacheStore.getState().actions.setOfflineSync(p);
};

export const publishQueue = (q: OfflineQueueSummary | undefined): void => {
    useCacheStore.getState().actions.setOfflineQueue(q);
};
