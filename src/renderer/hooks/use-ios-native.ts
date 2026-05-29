import { useEffect } from 'react';

import { useFullScreenPlayerStore } from '/@/renderer/store';

/**
 * iOS-native helpers. No-ops outside the Capacitor iOS WebView (Electron /
 * web / Android), so they're safe to mount unconditionally from app.tsx.
 *
 * These exist separately from use-android-native.ts because the two platforms
 * want opposite WebView / status-bar behaviour:
 *
 *   - Android's WebView reports env(safe-area-inset-*) as 0, so the Android
 *     hooks lift the WebView below the system bars (overlay:false) and inject
 *     fixed --android-safe-* fallback insets.
 *   - iOS's WKWebView reports real safe-area insets, so we keep the WebView
 *     edge-to-edge (overlay:true) and let env() drive the mobile shell's
 *     padding — no fixed fallbacks needed.
 *
 * Plugins are imported lazily so the web / Electron bundles don't pull native
 * plugin code they don't need. Background audio + the lock-screen now-playing
 * surface are handled elsewhere (AVAudioSession in AppDelegate.swift and the
 * navigator.mediaSession web hook respectively), so there is no iOS analogue
 * of the Android foreground-service / keep-awake wiring here — keep-awake is
 * cross-platform and stays in use-android-native.ts.
 */

const importCapacitorCore = () => import('@capacitor/core');

const isIos = async () => {
    try {
        const { Capacitor } = await importCapacitorCore();
        return Capacitor.getPlatform() === 'ios';
    } catch {
        return false;
    }
};

/*
 * NB: there is deliberately no iOS "body flag" hook. The Android build sets
 * html[data-capacitor-android="true"] purely to inject fixed --android-safe-*
 * fallback insets, because the Android WebView reports env(safe-area-inset-*)
 * as 0. iOS's WKWebView reports those insets correctly, so the existing
 * `max(env(...), var(--android-safe-*, 0px))` rules already resolve to the
 * right notch / Dynamic Island / home-indicator values on iOS with no flag and
 * no fallback — adding an unused data-capacitor-ios attribute would just be
 * dead scaffolding.
 */

/**
 * Status bar: light text (Style.Dark = light content for a dark background)
 * to match the app's dark theme, with the WebView left overlaying the status
 * bar (overlay:true) so env(safe-area-inset-top) keeps reporting the notch /
 * Dynamic Island height for the mobile shell's top padding.
 *
 * Also hides the OS status bar while the fullscreen player / visualizer
 * overlay is open (immersive), restoring it on close — mirroring the Android
 * hook. Re-applies the style on app resume because iOS occasionally resets the
 * WKWebView's status-bar appearance when returning from the background.
 *
 * StatusBar.setBackgroundColor is intentionally NOT called — it is a no-op on
 * iOS (the OS status bar has no settable background; it shows through to
 * whatever the WebView paints beneath it).
 */
export const useIosStatusBar = () => {
    useEffect(() => {
        let cancelled = false;
        let StatusBarApi: null | typeof import('@capacitor/status-bar').StatusBar = null;
        let StyleEnum: null | typeof import('@capacitor/status-bar').Style = null;
        let resumeHandle: null | { remove: () => Promise<void> } = null;

        const applyStatusBar = async () => {
            try {
                if (!(await isIos())) return;
                if (cancelled) return;
                const { StatusBar, Style } = await import('@capacitor/status-bar');
                if (cancelled) return;
                StatusBarApi = StatusBar;
                StyleEnum = Style;
                await StatusBar.setStyle({ style: Style.Dark });
                await StatusBar.setOverlaysWebView({ overlay: true });
            } catch (error) {
                console.warn('[ios] status bar setup failed:', error);
            }
        };

        void applyStatusBar();

        let lastHidden = false;
        const sync = (hidden: boolean) => {
            if (!StatusBarApi || hidden === lastHidden) return;
            lastHidden = hidden;
            try {
                if (hidden) {
                    void StatusBarApi.hide();
                } else {
                    void StatusBarApi.show();
                }
            } catch (error) {
                console.warn('[ios] status bar visibility toggle failed:', error);
            }
        };

        const unsubFs = useFullScreenPlayerStore.subscribe((state) => {
            sync(state.expanded || state.visualizerExpanded);
        });

        // Re-apply the status-bar style/overlay whenever the app returns to the
        // foreground, then re-sync visibility to the live overlay state.
        const registerLifecycle = async () => {
            try {
                if (!(await isIos())) return;
                if (cancelled) return;
                const { App: CapApp } = await import('@capacitor/app');
                if (cancelled) return;
                const handle = await CapApp.addListener('appStateChange', async ({ isActive }) => {
                    if (!isActive) return;
                    try {
                        if (!StatusBarApi || !StyleEnum) return;
                        await StatusBarApi.setStyle({ style: StyleEnum.Dark });
                        await StatusBarApi.setOverlaysWebView({ overlay: true });
                        const fs = useFullScreenPlayerStore.getState();
                        const shouldHide = fs.expanded || fs.visualizerExpanded;
                        lastHidden = !shouldHide; // flip so sync() actually fires
                        sync(shouldHide);
                    } catch (error) {
                        console.warn('[ios] status bar resume re-apply failed:', error);
                    }
                });
                if (cancelled) {
                    void handle.remove();
                    return;
                }
                resumeHandle = handle;
            } catch (error) {
                console.warn('[ios] status bar lifecycle listener failed:', error);
            }
        };

        void registerLifecycle();

        return () => {
            cancelled = true;
            unsubFs();
            if (resumeHandle) {
                void resumeHandle.remove();
                resumeHandle = null;
            }
            try {
                void StatusBarApi?.show();
            } catch {
                /* ignore — best-effort restore on unmount */
            }
        };
    }, []);
};
