import { useEffect } from 'react';

import { usePlayerActions, usePlayerStatus } from '/@/renderer/store';
import { PlayerStatus } from '/@/shared/types/types';

/**
 * Android-native helpers. All of these are no-ops when running outside the
 * Capacitor WebView (i.e. in Electron or the plain web build), so they're
 * safe to mount unconditionally from app.tsx.
 *
 * Each hook does its own Capacitor.isNativePlatform() check and resolves the
 * plugin lazily via dynamic import — this keeps the web/Electron bundles from
 * pulling Capacitor plugin code that they don't need.
 */

const importCapacitorCore = () => import('@capacitor/core');

const isNative = async () => {
    try {
        const { Capacitor } = await importCapacitorCore();
        return Capacitor.isNativePlatform();
    } catch {
        return false;
    }
};

/**
 * Flags <html> with `data-capacitor-android="true"` so global CSS rules can
 * apply Android-specific safe-area fallbacks (notably a min padding for the
 * bottom gesture-nav pill, since env(safe-area-inset-bottom) is reported as
 * 0 inside the Capacitor 8 WebView even with viewport-fit=cover + the
 * StatusBar plugin's overlay=false).
 *
 * No-op outside Capacitor; the flag is set once on first mount and stays
 * for the lifetime of the page (which on Capacitor is one app session).
 */
export const useAndroidBodyFlag = () => {
    useEffect(() => {
        let cancelled = false;

        const apply = async () => {
            try {
                if (!(await isNative())) return;
                if (cancelled) return;
                document.documentElement.setAttribute('data-capacitor-android', 'true');

                /*
                 * Capacitor 8's Android WebView reports
                 * `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`
                 * as 0px even when the StatusBar plugin's
                 * setOverlaysWebView({ overlay: false }) call lifts the
                 * WebView below the system bars. Many vendor Androids
                 * (crDroid, MIUI, OneUI) also ignore the
                 * `windowOptOutEdgeToEdgeEnforcement` attribute, so we
                 * end up with our header / titlebar / modal headers
                 * painted under the status-bar clock.
                 *
                 * Set explicit fallback inset variables on the document
                 * root so every CSS rule that uses
                 * `max(env(safe-area-inset-top, 0px), var(--android-safe-top, 0px))`
                 * gets a real value. Tuned to the Material 3 status-bar
                 * (24dp) plus a small comfort margin so notched / hole-
                 * punch devices like the Pixel 8 don't crowd the title
                 * against the camera cutout. The bottom fallback covers
                 * the gesture-nav pill (typically 16dp + 12dp pill
                 * height).
                 */
                document.documentElement.style.setProperty('--android-safe-top', '28px');
                document.documentElement.style.setProperty('--android-safe-bottom', '28px');
            } catch {
                // ignore
            }
        };

        void apply();

        return () => {
            cancelled = true;
        };
    }, []);
};

/**
 * Status bar: dark icons on a black background so the OS strip matches the
 * app's dark theme instead of showing the WebView default.
 */
export const useAndroidStatusBar = () => {
    useEffect(() => {
        let cancelled = false;

        const applyStatusBar = async () => {
            try {
                if (!(await isNative())) return;
                if (cancelled) return;
                const { StatusBar, Style } = await import('@capacitor/status-bar');
                if (cancelled) return;
                await StatusBar.setStyle({ style: Style.Dark });
                await StatusBar.setBackgroundColor({ color: '#000000' });
                await StatusBar.setOverlaysWebView({ overlay: false });
            } catch (error) {
                console.warn('[android] status bar setup failed:', error);
            }
        };

        void applyStatusBar();

        return () => {
            cancelled = true;
        };
    }, []);
};

/**
 * Hardware back button: walk back through router history when there's
 * anything to pop; exit the app only when the user is at the root.
 */
export const useAndroidBackButton = () => {
    useEffect(() => {
        let cancelled = false;
        let cleanup: (() => void) | null = null;

        const register = async () => {
            try {
                if (!(await isNative())) return;
                if (cancelled) return;
                const { App: CapApp } = await import('@capacitor/app');
                if (cancelled) return;

                const handle = await CapApp.addListener('backButton', ({ canGoBack }) => {
                    if (canGoBack && window.history.length > 1) {
                        window.history.back();
                    } else {
                        void CapApp.exitApp();
                    }
                });

                if (cancelled) {
                    void handle.remove();
                    return;
                }

                cleanup = () => {
                    void handle.remove();
                };
            } catch (error) {
                console.warn('[android] back button listener failed:', error);
            }
        };

        void register();

        return () => {
            cancelled = true;
            if (cleanup) cleanup();
        };
    }, []);
};

/**
 * Force the internal player volume to 100% on Android. We hide the
 * in-app volume slider in the Capacitor build (the OS volume rocker is
 * the single source of truth on a phone), but the underlying audio
 * engine still attenuates by its stored volume value — if the user had
 * previously set 60% on the web build, that 60% would carry over and
 * silently cut the playback level when the same profile syncs to the
 * Android install. Bootstrap it back to 100% once on mount so the OS
 * volume is the only attenuator.
 *
 * No-op outside Capacitor Android; Electron / web users keep their
 * previously-saved volume.
 */
export const useAndroidForceFullVolume = () => {
    const { setVolume } = usePlayerActions();

    useEffect(() => {
        let cancelled = false;

        const apply = async () => {
            try {
                if (!(await isNative())) return;
                if (cancelled) return;
                const { Capacitor } = await importCapacitorCore();
                if (Capacitor.getPlatform() !== 'android') return;
                if (cancelled) return;
                setVolume(100);
            } catch {
                // ignore
            }
        };

        void apply();

        return () => {
            cancelled = true;
        };
        // setVolume identity from zustand is stable across renders.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
};

/**
 * Wake lock during playback: hold the screen on while audio is PLAYING,
 * release otherwise. Uses the @capacitor-community/keep-awake plugin.
 */
export const useAndroidKeepAwake = () => {
    const status = usePlayerStatus();

    useEffect(() => {
        let cancelled = false;

        const apply = async () => {
            try {
                if (!(await isNative())) return;
                if (cancelled) return;
                const { KeepAwake } = await import('@capacitor-community/keep-awake');
                if (cancelled) return;

                if (status === PlayerStatus.PLAYING) {
                    await KeepAwake.keepAwake();
                } else {
                    await KeepAwake.allowSleep();
                }
            } catch (error) {
                console.warn('[android] keep-awake transition failed:', error);
            }
        };

        void apply();

        return () => {
            cancelled = true;
        };
    }, [status]);

    useEffect(() => {
        return () => {
            void (async () => {
                try {
                    if (!(await isNative())) return;
                    const { KeepAwake } = await import('@capacitor-community/keep-awake');
                    await KeepAwake.allowSleep();
                } catch {
                    // intentionally swallow: cleanup best-effort.
                }
            })();
        };
    }, []);
};
