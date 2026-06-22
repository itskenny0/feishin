import { useEffect } from 'react';

import { useBottomSheetStore } from '/@/renderer/features/jellyfin-remote-target/components/bottom-sheet/bottom-sheet-store';
import { SETTINGS_SUBPAGES } from '/@/renderer/features/settings/subpages';
import { MOBILE_SHELL_QUERY } from '/@/renderer/hooks/use-breakpoint';
import {
    useAppStore,
    useFullScreenPlayerStore,
    usePlayerActions,
    usePlayerStatus,
    useSettingsStore,
} from '/@/renderer/store';
import { PlayerStatus } from '/@/shared/types/types';

/**
 * Android-native helpers. All of these are no-ops when running outside the
 * Capacitor WebView (i.e. in Electron or the plain web build), so they're
 * safe to mount unconditionally from app.tsx.
 *
 * Most hooks gate on Capacitor.getPlatform() === 'android' (via isAndroid)
 * because their behaviour is Android-specific: the status-bar hook calls
 * setOverlaysWebView({ overlay: false }) and the body-flag hook forces
 * --android-safe-* insets — both correct on Android (whose WebView reports
 * env(safe-area-inset-*) as 0) but wrong on iOS (where WKWebView reports real
 * insets and we want the WebView edge-to-edge). iOS gets its own equivalents
 * in use-ios-native.ts. The one exception is useAndroidKeepAwake, which is
 * genuinely cross-platform (the keep-awake plugin has an iOS implementation
 * and holding the screen on during playback is desirable on both), so it
 * gates on the broader isNative().
 *
 * Each hook resolves the plugin lazily via dynamic import — this keeps the
 * web/Electron bundles from pulling Capacitor plugin code they don't need.
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

const isAndroid = async () => {
    try {
        const { Capacitor } = await importCapacitorCore();
        return Capacitor.getPlatform() === 'android';
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
                if (!(await isAndroid())) return;
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
 *
 * Also toggles status-bar visibility based on the fullscreen player /
 * visualizer state subscribed from the fullscreen-player store. When
 * either overlay is open, hide the OS status bar so the immersive view
 * truly covers the screen; on close, restore it. We subscribe via
 * useFullScreenPlayerStore.getState() + subscribe so the effect doesn't
 * tear down on every store change.
 *
 * Also re-applies style/background/overlay settings on app resume — Android
 * frequently drops them when the user backgrounds the app and the system
 * recycles the WebView (especially under low-memory or battery saver),
 * leaving the OS strip with the wrong text colour on next foreground.
 */
export const useAndroidStatusBar = () => {
    useEffect(() => {
        let cancelled = false;
        let StatusBarApi: null | typeof import('@capacitor/status-bar').StatusBar = null;
        let StyleEnum: null | typeof import('@capacitor/status-bar').Style = null;
        let resumeHandle: null | { remove: () => Promise<void> } = null;

        const applyStatusBar = async () => {
            try {
                if (!(await isAndroid())) return;
                if (cancelled) return;
                const { StatusBar, Style } = await import('@capacitor/status-bar');
                if (cancelled) return;
                StatusBarApi = StatusBar;
                StyleEnum = Style;
                await StatusBar.setStyle({ style: Style.Dark });
                await StatusBar.setBackgroundColor({ color: '#000000' });
                await StatusBar.setOverlaysWebView({ overlay: false });
            } catch (error) {
                console.warn('[android] status bar setup failed:', error);
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
                console.warn('[android] status bar visibility toggle failed:', error);
            }
        };

        const unsubFs = useFullScreenPlayerStore.subscribe((state) => {
            sync(state.expanded || state.visualizerExpanded);
        });

        // Re-apply status bar settings whenever the app comes back to the
        // foreground. Several OEM ROMs (and Android 14+ predictive back)
        // strip the style/background/overlay flags during background, so
        // the next foreground would show a light-icon strip on dark
        // chrome unless we re-set them here. Also re-sync visibility to
        // the current overlay state, since the system bar may have been
        // shown by the OS while we were paused.
        const registerLifecycle = async () => {
            try {
                if (!(await isAndroid())) return;
                if (cancelled) return;
                const { App: CapApp } = await import('@capacitor/app');
                if (cancelled) return;
                const handle = await CapApp.addListener('appStateChange', async ({ isActive }) => {
                    if (!isActive) return;
                    try {
                        if (!StatusBarApi || !StyleEnum) return;
                        await StatusBarApi.setStyle({ style: StyleEnum.Dark });
                        await StatusBarApi.setBackgroundColor({ color: '#000000' });
                        await StatusBarApi.setOverlaysWebView({ overlay: false });
                        // Force a re-sync against the live overlay state.
                        const fs = useFullScreenPlayerStore.getState();
                        const shouldHide = fs.expanded || fs.visualizerExpanded;
                        lastHidden = !shouldHide; // flip so sync() actually fires
                        sync(shouldHide);
                    } catch (error) {
                        console.warn('[android] status bar resume re-apply failed:', error);
                    }
                });
                if (cancelled) {
                    void handle.remove();
                    return;
                }
                resumeHandle = handle;
            } catch (error) {
                console.warn('[android] status bar lifecycle listener failed:', error);
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

/**
 * Hardware back button. Dismisses open overlays before walking back
 * through router history, in the order Android users expect:
 *
 *   1. Context menus / dropdowns / popovers — Radix listens for the
 *      Escape key and closes on it, so we dispatch a synthetic
 *      keydown('Escape') and bail out if anything handled it (i.e. the
 *      DOM has fewer popper wrappers afterwards).
 *   2. Visualizer overlay — collapse via the FullScreenPlayer store.
 *   3. Fullscreen player overlay — collapse via the same store.
 *   4. Command palette — close via the AppStore opener.
 *   4b. Settings drill-down — when on `/settings`, walk the in-page
 *       `tab` / `tabSubpage` zustand drill (subpage → subpages list →
 *       category list on mobile) instead of falling through to
 *       history.back() and exiting Settings entirely.
 *   5. Router history — if any back-stack exists, pop it.
 *   6. Exit the app — only when the user is at the root with nothing
 *      else open.
 *
 * Each store check is a one-shot read via `getState()` so this hook
 * doesn't re-subscribe / re-register the native listener on every
 * store change.
 */
export const useAndroidBackButton = () => {
    useEffect(() => {
        let cancelled = false;
        let cleanup: (() => void) | null = null;

        const register = async () => {
            try {
                if (!(await isAndroid())) return;
                if (cancelled) return;
                const { App: CapApp } = await import('@capacitor/app');
                if (cancelled) return;

                /*
                 * Lazy import the store hooks at handler-fire time
                 * (NOT module-load) so the cycle through
                 * use-android-native → store → react root doesn't
                 * fight Vite's import graph in dev. .getState() is
                 * the synchronous read; we don't subscribe.
                 */
                const handle = await CapApp.addListener('backButton', async ({ canGoBack }) => {
                    // 1. Dispatch Escape so Radix popovers / context
                    //    menus / Mantine modals close themselves. They
                    //    listen via document-level keydown, so this is
                    //    the cheapest universal "close any popup" call.
                    const popperWrappersBefore = document.querySelectorAll(
                        '[data-radix-popper-content-wrapper]',
                    ).length;
                    document.dispatchEvent(
                        new KeyboardEvent('keydown', {
                            bubbles: true,
                            cancelable: true,
                            code: 'Escape',
                            key: 'Escape',
                        }),
                    );
                    // Give Radix a frame to react then re-check.
                    await new Promise((r) => requestAnimationFrame(r));
                    const popperWrappersAfter = document.querySelectorAll(
                        '[data-radix-popper-content-wrapper]',
                    ).length;
                    if (popperWrappersAfter < popperWrappersBefore) {
                        // Something popped. Consume the back press.
                        return;
                    }

                    // 1b. Custom bottom sheets (e.g. the mobile Jellyfin
                    //     "Connect to a device" picker). These render
                    //     outside the Radix popper tree, so the Escape
                    //     dispatch above doesn't reach them — they
                    //     register a dismiss callback in
                    //     useBottomSheetStore and we walk the stack
                    //     here. Without this, the back gesture used to
                    //     fall through to window.history.back() while
                    //     the sheet was open, which the Capacitor
                    //     WebView interpreted as "leave the app".
                    if (useBottomSheetStore.getState().dismissTop()) return;

                    // 2-4. Stored overlays. Read via getState() (not the
                    //      hook factories) so we can call from outside a
                    //      React component. The stores are STATIC
                    //      imports above — we tried dynamic `await
                    //      import('/@/renderer/store')` here in v21pp/ss
                    //      and Rollup duplicated the store-index chunk
                    //      (dynamic + static referenced the same path),
                    //      producing a "Cannot access X before
                    //      initialization" TDZ error at boot. Static
                    //      imports avoid that entirely.
                    const fsState = useFullScreenPlayerStore.getState();
                    if (fsState.visualizerExpanded) {
                        fsState.actions.setStore({ visualizerExpanded: false });
                        return;
                    }
                    if (fsState.expanded) {
                        fsState.actions.setStore({ expanded: false });
                        return;
                    }

                    const app = useAppStore.getState();
                    if (app.commandPalette.opened) {
                        app.commandPalette.close();
                        return;
                    }

                    // 4b. Settings drill-down. The mobile Settings UI is
                    //     a two-level drill (category list → subpages list
                    //     → subpage content) driven by zustand `tab` /
                    //     `tabSubpage`, NOT router history. Without this
                    //     step the hardware back gesture would fall
                    //     through to history.back() and exit Settings
                    //     entirely, instead of walking up one drill level
                    //     as the visible chrome implies. The HashRouter
                    //     puts the route in `location.hash` (e.g.
                    //     `#/settings` or `#/settings?foo=bar`), so we
                    //     match on the prefix after the leading `#`.
                    const hashPath = window.location.hash.replace(/^#/, '').split('?')[0];
                    if (hashPath === '/settings' || hashPath.startsWith('/settings/')) {
                        const settings = useSettingsStore.getState();
                        if (settings.tabSubpage) {
                            // A drill-down child subpage returns to its parent
                            // (one level up), mirroring the on-screen back
                            // chevron; a top-level subpage returns to the list.
                            const subpages = SETTINGS_SUBPAGES[settings.tab] ?? [];
                            const current = subpages.find((s) => s.id === settings.tabSubpage);
                            settings.actions.setSettings({ tabSubpage: current?.parent ?? '' });
                            return;
                        }
                        if (settings.tab) {
                            // Mobile only — desktop renders the category
                            // list as a permanent sidebar, so there's
                            // nothing to drill back into.
                            const isMobile =
                                window.matchMedia(MOBILE_SHELL_QUERY).matches ||
                                settings.general.mobileShellForce;
                            if (isMobile) {
                                settings.actions.setSettings({ tab: '' });
                                return;
                            }
                        }
                    }

                    // 5. Router history.
                    if (canGoBack && window.history.length > 1) {
                        window.history.back();
                        return;
                    }

                    // 6. Final fallback.
                    void CapApp.exitApp();
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
 *
 * Also pauses the wake lock when the app goes to the background — holding
 * keep-awake while paused (no UI visible) is a battery footgun on devices
 * that don't auto-revoke wake locks for paused apps. On resume we re-arm
 * if playback is still active.
 */
/**
 * Hold the screen-on KeepAwake lock while `active` is true (release otherwise
 * and on unmount). The blocking first-sync gate uses this so a long first sync
 * isn't frozen by Android Doze when the screen times out: a PARTIAL_WAKE_LOCK
 * keeps the CPU on but Chromium still throttles/suspends WebView JS (and thus
 * the sweep) when the Activity isn't visible — keeping the screen on is what
 * actually keeps the JS running. Foreground-only by nature, so background
 * resyncs are unaffected. KeepAwake is a global (non-ref-counted) toggle, but
 * the gate blocks playback, so it never contends with the player's lock.
 */
export const useKeepAwakeWhile = (active: boolean) => {
    useEffect(() => {
        const set = async (on: boolean) => {
            try {
                if (!(await isNative())) return;
                const { KeepAwake } = await import('@capacitor-community/keep-awake');
                if (on) await KeepAwake.keepAwake();
                else await KeepAwake.allowSleep();
            } catch (error) {
                console.warn('[android] sync keep-awake transition failed:', error);
            }
        };
        void set(active);
        return () => {
            void set(false);
        };
    }, [active]);
};

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

    // Background / foreground lifecycle. We always release the wake lock
    // on background (no screen to keep awake when we're hidden) and
    // re-acquire on foreground if the player is still playing — Android
    // continues audio playback via the foreground service; only the
    // screen-on hint needs to follow the WebView's visibility.
    useEffect(() => {
        let cancelled = false;
        let resumeHandle: null | { remove: () => Promise<void> } = null;

        const register = async () => {
            try {
                if (!(await isNative())) return;
                if (cancelled) return;
                const { App: CapApp } = await import('@capacitor/app');
                const { KeepAwake } = await import('@capacitor-community/keep-awake');
                if (cancelled) return;
                const handle = await CapApp.addListener('appStateChange', async ({ isActive }) => {
                    try {
                        if (!isActive) {
                            await KeepAwake.allowSleep();
                            return;
                        }
                        // Resumed — re-acquire the lock if playback is
                        // still going. Reading status via a stale closure
                        // here would be wrong, so pull from the live
                        // store synchronously.
                        const { usePlayerStore } = await import('/@/renderer/store');
                        const live = usePlayerStore.getState();
                        if (live.player.status === PlayerStatus.PLAYING) {
                            await KeepAwake.keepAwake();
                        }
                    } catch (error) {
                        console.warn('[android] keep-awake lifecycle transition failed:', error);
                    }
                });
                if (cancelled) {
                    void handle.remove();
                    return;
                }
                resumeHandle = handle;
            } catch (error) {
                console.warn('[android] keep-awake lifecycle listener failed:', error);
            }
        };

        void register();

        return () => {
            cancelled = true;
            if (resumeHandle) void resumeHandle.remove();
        };
    }, []);

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
