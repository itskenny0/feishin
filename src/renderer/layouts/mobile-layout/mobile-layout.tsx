import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router';

import styles from './mobile-layout.module.css';

import {
    OfflineDownloadBanner,
    prepareExplicitRefresh,
    VolumeUnavailableBanner,
} from '/@/renderer/cache';
import { eventEmitter } from '/@/renderer/events/event-emitter';
import { ITEM_LIST_REFRESH_ALL } from '/@/renderer/events/events';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { RouteSkeleton } from '/@/renderer/features/shared/components/route-skeleton';
import { MobileSidebar } from '/@/renderer/features/sidebar/components/mobile-sidebar';
import { useIsBigPhone } from '/@/renderer/hooks/use-breakpoint';
import { useEdgeSwipe } from '/@/renderer/hooks/use-edge-swipe';
import { usePullToRefresh } from '/@/renderer/hooks/use-pull-to-refresh';
import { useSoftKeyboardVisible } from '/@/renderer/hooks/use-soft-keyboard-visible';
import { isTouchOrNative, PlayerBar } from '/@/renderer/layouts/default-layout/player-bar';
import { BottomTabBar } from '/@/renderer/layouts/mobile-layout/bottom-tab-bar';
import { WindowBar } from '/@/renderer/layouts/window-bar';
import { perfMarkNav } from '/@/renderer/lib/perf-log';
import {
    useFullScreenPlayerOverlayState,
    useMobileDrawer,
    usePlayerSong,
    useWindowBarStyle,
} from '/@/renderer/store';
import { Drawer } from '/@/shared/components/drawer/drawer';
import { Icon } from '/@/shared/components/icon/icon';
import { Platform } from '/@/shared/types/types';

// Both overlays are only ever mounted on demand (fullscreen player / visualizer
// expanded), so lazy-load them to keep their heavy graphs out of the
// first-paint entry chunk. The null Suspense fallback is invisible.
const FullScreenVisualizer = lazy(() =>
    import('/@/renderer/features/player/components/full-screen-visualizer').then((m) => ({
        default: m.FullScreenVisualizer,
    })),
);
const MobileFullscreenPlayer = lazy(() =>
    import('/@/renderer/features/player/components/mobile-fullscreen-player').then((m) => ({
        default: m.MobileFullscreenPlayer,
    })),
);

interface MobileLayoutProps {
    shell?: boolean;
}

export const MobileLayout = ({ shell }: MobileLayoutProps) => {
    const { t } = useTranslation();
    // The side ("More") drawer state lives in the app store so the Settings
    // view can open it now that it's no longer a bottom-tab-bar tab. Edge-swipe
    // + the in-drawer nav-close still drive it here.
    const { close: closeSidebar, open: openSidebar, opened: sidebarOpened } = useMobileDrawer();
    const {
        expanded: isFullScreenPlayerExpanded,
        visualizerExpanded: isFullScreenVisualizerExpanded,
    } = useFullScreenPlayerOverlayState();
    const windowBarStyle = useWindowBarStyle();
    const isBigPhone = useIsBigPhone();
    const mainContentRef = useRef<HTMLElement>(null);
    const queryClient = useQueryClient();
    /*
     * Hide the mobile mini-player when nothing is queued. Without this
     * the grid still reserves --mobile-playerbar-height for an empty
     * floating row (Spotify hides the bar entirely until a track is
     * picked). Pair this with the .has-no-song layout-class below which
     * collapses the player grid track to 0.
     */
    const currentSong = usePlayerSong();
    // Show the player bar when something is playing locally OR a Jellyfin
    // Connect target is active — so connecting to a remote (even an
    // already-playing one) surfaces the bar + its controls and cast button,
    // and the bar stays put while controlling the remote.
    const remoteTargetActive = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const hasSong = Boolean(currentSong?.id) || remoteTargetActive;

    // When the soft keyboard opens, the mini-player slides out of view
    // (player-bar's own .keyboard-hidden). But its grid track still reserves
    // --mobile-playerbar-height, leaving a black band between content and the
    // tab bar. Collapse the player row to 0 here — same gate as the bar's hide,
    // so the two never desync — exactly as .has-no-song does for an empty queue.
    const keyboardVisible = useSoftKeyboardVisible({ enabled: isTouchOrNative() });

    // Pull-to-refresh on the main content scroll container. A top overscroll
    // is the user's explicit "go to the server now": open the sync-first
    // explicit-refresh window (drops the row cache + library snapshots so
    // fresh pages land even when the local cache is authoritative),
    // broadcast ITEM_LIST_REFRESH so whichever list loader is mounted runs
    // its forced-network refresh mutation, then invalidate every active
    // react-query query so detail/count/sidecar surfaces revalidate too.
    // The hook only fires for touch pointers and only when the scroll
    // container is at the top, so it never fights normal mid-scroll touches.
    const handleRefresh = useCallback(async () => {
        prepareExplicitRefresh('all');
        eventEmitter.emit('ITEM_LIST_REFRESH', { key: ITEM_LIST_REFRESH_ALL });
        await queryClient.invalidateQueries({ refetchType: 'active' });
    }, [queryClient]);

    const { distance: pullDistance, refreshing } = usePullToRefresh(mainContentRef, {
        disabled: isFullScreenPlayerExpanded || isFullScreenVisualizerExpanded,
        onRefresh: handleRefresh,
    });

    // Edge-swipe to open the side drawer: a finger landing within 24px of
    // the left edge and dragging inward past 60px opens the drawer. Mirrors
    // Android's standard navigation-drawer gesture. Disabled while the
    // drawer is already open (close gesture is the drawer's own backdrop
    // tap / dismiss) and while the fullscreen player is up (otherwise the
    // user's swipe-down-to-dismiss gestures would also poke the drawer).
    useEdgeSwipe({
        disabled: sidebarOpened || isFullScreenPlayerExpanded || isFullScreenVisualizerExpanded,
        onSwipeOpen: openSidebar,
    });

    // Auto-close the drawer when the user taps a navigation link inside it.
    // Without this the drawer would stay open over the destination route
    // until the user manually swiped it away — annoying when you've just
    // tapped a playlist or sidebar item and want to see it.
    const location = useLocation();
    useEffect(() => {
        // Perf: mark each route change so route components can log their settle
        // time relative to it (and emit a `[perf] nav` line).
        perfMarkNav(location.pathname);
        if (sidebarOpened) closeSidebar();
        // closeSidebar identity is stable from useDisclosure; sidebarOpened
        // is intentionally not included so a manual open from anywhere
        // doesn't immediately re-close.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [location.pathname]);

    // On Android (Capacitor) the WindowBar's native min/max/close controls are
    // meaningless and just steal vertical space — Platform.WEB is what we get
    // inside the WebView, and the bar's own render guard handles that. We add
    // a layout-side class that pulls the bar row to 0 anyway, so themes that
    // do render the bar on web (e.g. PWA on iOS) still get the correct grid.
    const showWindowBar =
        !shell && (windowBarStyle === Platform.MACOS || windowBarStyle === Platform.WINDOWS);

    return (
        <>
            <div
                className={clsx(styles.layout, {
                    [styles.hasNoSong]: !hasSong,
                    [styles.keyboardHidden]: keyboardVisible,
                    [styles.macos]: windowBarStyle === Platform.MACOS,
                    [styles.windows]: windowBarStyle === Platform.WINDOWS,
                })}
                id="mobile-layout"
            >
                {showWindowBar && <WindowBar />}
                <main className={styles.mainContent} ref={mainContentRef}>
                    {(pullDistance > 0 || refreshing) && (
                        <motion.div
                            animate={{
                                opacity: refreshing ? 1 : Math.min(1, pullDistance / 80),
                                y: refreshing ? 56 : pullDistance,
                            }}
                            aria-label={t('common.refreshing', { defaultValue: 'Refreshing' })}
                            className={styles.pullToRefresh}
                            initial={false}
                            transition={refreshing ? { duration: 0 } : { duration: 0 }}
                        >
                            <Icon
                                className={refreshing ? styles.pullToRefreshSpinning : undefined}
                                icon="refresh"
                                size="lg"
                            />
                        </motion.div>
                    )}
                    <Suspense fallback={<RouteSkeleton />}>
                        <Outlet />
                    </Suspense>
                </main>
                {hasSong && <PlayerBar />}
                <BottomTabBar
                    onScrollToTop={() => {
                        // Soft-scroll the main content + any inner
                        // scrollables back to the top so re-tapping the
                        // active tab snaps back to the start of the page
                        // (Spotify pattern). Best-effort.
                        const main = mainContentRef.current;
                        if (!main) return;
                        const reduceMotion = window.matchMedia?.(
                            '(prefers-reduced-motion: reduce)',
                        ).matches;
                        const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
                        main.scrollTo({ behavior, top: 0 });
                        /*
                         * Most routes own their own scroll container — a
                         * NativeScrollArea (OverlayScrollbars, whose real
                         * scroller carries [data-overlayscrollbars-viewport])
                         * or a virtualized grid/table viewport. The outer
                         * main-content scroll above does nothing for those,
                         * so reset every scroller we can find. (The previous
                         * `[data-scrollable]` selector matched nothing in the
                         * tree and silently no-opped.)
                         */
                        const scrollers = main.querySelectorAll<HTMLElement>(
                            '[data-overlayscrollbars-viewport]',
                        );
                        scrollers.forEach((el) => {
                            if (el.scrollTop > 0) el.scrollTo({ behavior, top: 0 });
                        });
                    }}
                />
            </div>
            <Drawer
                onClose={closeSidebar}
                opened={sidebarOpened}
                position="left"
                // Big-phone tier (361–430px) — iPhone 13/14/15 Pro Max,
                // Pixel 8 Pro, Galaxy S24 Ultra, etc. — gets a wider
                // drawer (360px vs the default 320px) so the sidebar
                // items breathe instead of crowding against the
                // accordion chevrons. Sub-360 phones keep the 320px
                // default so the drawer doesn't swallow the viewport.
                size={isBigPhone ? '360px' : '320px'}
                styles={{
                    body: {
                        height: '100%',
                        padding: 0,
                    },
                    content: {
                        height: '100%',
                        width: '100%',
                    },
                }}
                withCloseButton={false}
            >
                <MobileSidebar onSwipeClose={closeSidebar} />
            </Drawer>
            <AnimatePresence initial={false}>
                {/*
                 * Suppress the player overlay while the visualizer is up.
                 * Without this both overlays are mounted simultaneously
                 * and the player header's settings cog (and any popover
                 * it has open) shows through next to the visualizer's
                 * close button — taps on it also tear the layout
                 * because the popover anchors to a position covered by
                 * the visualizer. The visualizer is self-contained and
                 * has its own close affordance to return to the player.
                 */}
                {isFullScreenPlayerExpanded && !isFullScreenVisualizerExpanded && (
                    <div className={styles.fullScreenPlayerOverlay}>
                        <Suspense fallback={null}>
                            <MobileFullscreenPlayer />
                        </Suspense>
                    </div>
                )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
                {isFullScreenVisualizerExpanded && (
                    <div className={styles.fullScreenPlayerOverlay}>
                        <Suspense fallback={null}>
                            <FullScreenVisualizer />
                        </Suspense>
                    </div>
                )}
            </AnimatePresence>
            <OfflineDownloadBanner />
            <VolumeUnavailableBanner />
            <ContextMenuController.Root />
        </>
    );
};
