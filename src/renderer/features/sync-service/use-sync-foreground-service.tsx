// Lifecycle hook for the Android background-sync foreground service. Starts the
// controller (which drives the native SyncForegroundService plugin from the
// cache-store progress state) while the gate is satisfied, and tears it down
// when the gate goes false / on unmount.
//
// Gate (all must hold):
//   - isAndroidNative()                              — Android-native only
//   - localCache.enabled === true                    — cache subsystem is on
//   - localCache.android.backgroundSync !== false    — toggle (default on)
//
// Mounted (lazily) from audio-players alongside the other *Hook components.

import { useEffect } from 'react';

import type { SyncForegroundController } from './sync-foreground-controller';

import { isAndroidNative } from './sync-foreground-bridge';
import { startSyncForegroundController } from './sync-foreground-controller';

import { useSettingsStore } from '/@/renderer/store';

const TAG = '[sync-service]';

export const useSyncForegroundService = (): void => {
    const active = useSettingsStore(
        (state) =>
            state.localCache?.enabled === true &&
            state.localCache?.android?.backgroundSync !== false,
    );

    useEffect(() => {
        if (!isAndroidNative() || !active) return undefined;
        console.info(`${TAG} gate open — starting controller`);
        const controller: SyncForegroundController = startSyncForegroundController();
        return () => {
            console.info(`${TAG} gate closed — stopping controller`);
            controller.stop();
        };
    }, [active]);
};

export const SyncForegroundServiceHook = (): null => {
    useSyncForegroundService();
    return null;
};
