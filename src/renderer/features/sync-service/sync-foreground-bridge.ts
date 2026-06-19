// Renderer wrapper for the native SyncForegroundService Capacitor plugin
// (android/.../SyncForegroundServicePlugin.java). Mirrors the registerPlugin +
// isAndroidNative() guard pattern from cache/backends/volumes.ts and the
// dedicated-bridge style from home-assistant/ha-mqtt-client.ts.
//
// The native plugin wraps each JS sync pipeline (image-cache sweep +
// offline-media downloads) in a typed dataSync foreground service + a shared
// partial wake lock + a per-pipeline progress notification, so the existing
// promise/fetch-chained sync keeps progressing while the app is backgrounded /
// the screen is locked. It does NOT re-implement sync.
//
// Every method no-ops (resolves) off Android-native so the controller can call
// them unconditionally; the registerPlugin proxy on other platforms would
// otherwise reject.

import type { PluginListenerHandle } from '@capacitor/core';

import { Capacitor, registerPlugin } from '@capacitor/core';

const TAG = '[sync-service]';

export interface SyncActionEvent {
    action: SyncActionVerb;
    kind: SyncKind;
}
export type SyncActionVerb = 'pause' | 'stop';

export interface SyncForegroundServicePlugin {
    addListener(
        eventName: 'syncAction',
        listener: (event: SyncActionEvent) => void,
    ): Promise<PluginListenerHandle>;
    start(o: { kind: SyncKind }): Promise<void>;
    stop(o: { kind: SyncKind }): Promise<void>;
    update(o: SyncUpdateArgs): Promise<void>;
}

export type SyncKind = 'downloads' | 'images';

export interface SyncUpdateArgs {
    indeterminate?: boolean;
    kind: SyncKind;
    max?: number;
    progress?: number;
    text?: string;
    title?: string;
}

// The native plugin lives in android/.../SyncForegroundServicePlugin.java. On
// other platforms registerPlugin returns a proxy that rejects on call — guarded
// by isAndroidNative() before every use.
export const SyncForegroundService =
    registerPlugin<SyncForegroundServicePlugin>('SyncForegroundService');

export const isAndroidNative = (): boolean =>
    Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';

export const startSyncService = async (kind: SyncKind): Promise<void> => {
    if (!isAndroidNative()) return;
    try {
        await SyncForegroundService.start({ kind });
        console.info(`${TAG} start`, { kind });
    } catch (err) {
        console.warn(`${TAG} start failed`, { err, kind });
    }
};

export const updateSyncService = async (args: SyncUpdateArgs): Promise<void> => {
    if (!isAndroidNative()) return;
    try {
        await SyncForegroundService.update(args);
    } catch (err) {
        console.warn(`${TAG} update failed`, { err, kind: args.kind });
    }
};

export const stopSyncService = async (kind: SyncKind): Promise<void> => {
    if (!isAndroidNative()) return;
    try {
        await SyncForegroundService.stop({ kind });
        console.info(`${TAG} stop`, { kind });
    } catch (err) {
        console.warn(`${TAG} stop failed`, { err, kind });
    }
};

export const addSyncActionListener = async (
    cb: (event: SyncActionEvent) => void,
): Promise<(() => void) | undefined> => {
    if (!isAndroidNative()) return undefined;
    try {
        const handle = await SyncForegroundService.addListener('syncAction', cb);
        return () => {
            void handle.remove();
        };
    } catch (err) {
        console.warn(`${TAG} addSyncActionListener failed`, { err });
        return undefined;
    }
};
