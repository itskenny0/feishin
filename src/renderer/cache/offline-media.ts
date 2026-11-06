// Back-compat shim. The offline-download engine now lives in ./offline/*;
// these names keep the historical import paths working.

import { offlineManager } from './offline/manager';

export { refreshOfflineAvailability, refreshOfflineStats } from './offline/stats';

/** Pause whichever target is downloading right now (the old "cancel" button). */
export const cancelOfflineSync = (): void => {
    // Fire-and-forget from the UI's perspective, but a bare `void` on a
    // rejecting promise is an unhandled rejection — catch it here so a
    // transient Dexie write failure logs instead of surfacing as a crash.
    void offlineManager.pauseActive().catch((err) => {
        console.warn('[offline-media] cancelOfflineSync failed', err);
    });
};
