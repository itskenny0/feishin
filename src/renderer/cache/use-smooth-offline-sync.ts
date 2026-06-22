// useSmoothOfflineSync — live offline-download progress from the cache store
// (`offlineSync`). Raw passthrough: the rAF interpolation ("animate progress
// bar") was removed app-wide because re-rendering hosts at 20fps starved sync
// workers; progress now steps at the engine's own per-item cadence.

import type { OfflineSyncProgress } from './store';

import { useCacheStore } from './store';

export const useSmoothOfflineSync = (): OfflineSyncProgress | undefined =>
    useCacheStore((s) => s.offlineSync);
