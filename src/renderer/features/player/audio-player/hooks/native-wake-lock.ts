import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Thin renderer-side wrapper around the native cat.kenny.feishin.WakeLockPlugin
 * (see android/.../WakeLockPlugin.java).
 *
 * Holds a PARTIAL_WAKE_LOCK while audio plays so the CPU does not suspend with
 * the screen off — the WebView's HTML5 <audio> stalls otherwise on aggressive
 * OEM builds, which the media-session foreground service alone does not
 * prevent.
 *
 * Gated to Android: the plugin only ships an Android implementation. On every
 * other platform (web / Electron / iOS) the calls are no-ops — Electron keeps
 * the renderer alive on its own, iOS uses AVAudioSession's `audio` background
 * mode, and the web build never backgrounds the way a packaged app does.
 */
interface WakeLockPlugin {
    acquire(): Promise<void>;
    isHeld(): Promise<{ held: boolean }>;
    release(): Promise<void>;
}

const isAndroid = Capacitor.getPlatform() === 'android';

// registerPlugin returns a proxy even when no native implementation is present;
// guarding every call on isAndroid keeps the non-Android bundles from invoking
// a plugin that does not exist there.
const plugin: null | WakeLockPlugin = isAndroid ? registerPlugin<WakeLockPlugin>('WakeLock') : null;

/** Acquire the native partial wake lock (Android only; no-op elsewhere). */
export const acquireWakeLock = (): void => {
    plugin?.acquire().catch((err: unknown) => {
        console.warn('[wake-lock] acquire failed', err);
    });
};

/** Release the native partial wake lock (Android only; no-op elsewhere). */
export const releaseWakeLock = (): void => {
    plugin?.release().catch((err: unknown) => {
        console.warn('[wake-lock] release failed', err);
    });
};
