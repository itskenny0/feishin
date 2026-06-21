// [sync-only] Mirrors library-sync progress onto the Electron taskbar/dock
// progress bar + a persistent OS notification while the window is backgrounded.
//
// Android already drives its own foreground-service notification from the same
// cache-store `sweep` state (see features/sync-service/), and iOS has no
// equivalent, so this hook only does work in Electron — it no-ops everywhere
// else. It subscribes to the cache store's `sweep` field and throttles IPC to
// the main process to ~1 Hz.

import isElectron from 'is-electron';
import { useEffect } from 'react';

import { formatBytes, formatCount } from '../format';
import { useCacheStore } from '../store';

const ipc = isElectron() ? window.api?.ipc : null;
const THROTTLE_MS = 1000;

export const useSyncNotification = (): void => {
    useEffect(() => {
        if (!ipc) return undefined;

        let lastSentAt = 0;
        let wasActive = false;

        const push = (): void => {
            const { sweep } = useCacheStore.getState();
            if (!sweep) {
                if (wasActive) {
                    wasActive = false;
                    ipc.send('sync-progress', { active: false });
                }
                return;
            }
            const now = Date.now();
            if (wasActive && now - lastSentAt < THROTTLE_MS) return;
            lastSentAt = now;
            wasActive = true;

            const { bytesDownloaded, done, paused, total } = sweep.progress;
            const hasTotal = typeof total === 'number' && total > 0;
            const fraction = hasTotal ? Math.min(1, done / total) : -1;
            const body = paused
                ? 'Paused (offline)'
                : `${formatCount(done)}${hasTotal ? ` / ${formatCount(total)}` : ''} · ${formatBytes(
                      bytesDownloaded,
                  )}`;
            ipc.send('sync-progress', {
                active: true,
                body,
                fraction,
                title: `Syncing ${sweep.entity}`,
            });
        };

        // Drive on store transitions; the store updates per page/blob so this
        // covers progress without a separate timer.
        const unsubscribe = useCacheStore.subscribe(push);
        push();

        return () => {
            unsubscribe();
            // Clear the progress bar / notification on unmount.
            ipc.send('sync-progress', { active: false });
        };
    }, []);
};
