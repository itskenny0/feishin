import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { AnimatePresence, motion } from 'motion/react';
import { Suspense, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router';

import styles from './mobile-layout.module.css';

import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { FullScreenVisualizer } from '/@/renderer/features/player/components/full-screen-visualizer';
import { MobileFullscreenPlayer } from '/@/renderer/features/player/components/mobile-fullscreen-player';
import { RouteSkeleton } from '/@/renderer/features/shared/components/route-skeleton';
import { MobileSidebar } from '/@/renderer/features/sidebar/components/mobile-sidebar';
import { useIsBigPhone } from '/@/renderer/hooks/use-breakpoint';
import { useEdgeSwipe } from '/@/renderer/hooks/use-edge-swipe';
import { usePullToRefresh } from '/@/renderer/hooks/use-pull-to-refresh';
import { PlayerBar } from '/@/renderer/layouts/default-layout/player-bar';
import { BottomTabBar } from '/@/renderer/layouts/mobile-layout/bottom-tab-bar';
import { WindowBar } from '/@/renderer/layouts/window-bar';
import {
    useCommandPaletteState,
    useFullScreenPlayerOverlayState,
    useWindowBarStyle,
} from '/@/renderer/store';
import { Drawer } from '/@/shared/components/drawer/drawer';
import { Icon } from '/@/shared/components/icon/icon';
import { useDisclosure } from '/@/shared/hooks/use-disclosure';
import { Platform } from '/@/shared/types/types';

interface MobileLayoutProps {
    shell?: boolean;
}

export const MobileLayout = ({ shell }: MobileLayoutProps) => {
    const { t } = useTranslation();
    const [sidebarOpened, { close: closeSidebar, open: openSidebar }] = useDisclosure(false);
    const {
        expanded: isFullScreenPlayerExpanded,
        visualizerExpanded: isFullScreenVisualizerExpanded,
    } = useFullScreenPlayerOverlayState();
    const windowBarStyle = useWindowBarStyle();
    const isBigPhone = useIsBigPhone();
    const mainContentRef = useRef<HTMLElement>(null);
    const queryClient = useQueryClient();
    const { open: openCommandPalette } = useCommandPaletteState();

    // Pull-to-refresh on the main content scroll container: invalidate all
    // active react-query queries so the current route refetches. The hook
    // only fires for touch pointers and only when the scroll container is
    // at the top, so it never fights normal mid-scroll touches.
    const handleRefresh = useCallback(async () => {
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
                <PlayerBar />
                <BottomTabBar
                    drawerOpen={sidebarOpened}
                    onMoreTab={sidebarOpened ? closeSidebar : openSidebar}
                    onOpenSearch={openCommandPalette}
                    onScrollToTop={() => {
                        // Soft-scroll the main content + any inner
                        // scrollable nearest to the top so re-tapping
                        // the active tab snaps back to the start of
                        // the page (Spotify pattern). Best-effort —
                        // routes that own their own scroll containers
                        // get the outer scroll reset for free anyway
                        // because main-content also scrolls.
                        const main = mainContentRef.current;
                        if (main) {
                            main.scrollTo({ behavior: 'smooth', top: 0 });
                            // Also walk to the first inner scrollable
                            // child and reset it — routes that render
                            // a NativeScrollArea or OverlayScrollbars
                            // inside main-content need this to actually
                            // snap to top.
                            const inner = main.querySelector<HTMLElement>('[data-scrollable]');
                            inner?.scrollTo({ behavior: 'smooth', top: 0 });
                        }
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
                {isFullScreenPlayerExpanded && (
                    <div className={styles.fullScreenPlayerOverlay}>
                        <MobileFullscreenPlayer />
                    </div>
                )}
            </AnimatePresence>
            <AnimatePresence initial={false}>
                {isFullScreenVisualizerExpanded && (
                    <div className={styles.fullScreenPlayerOverlay}>
                        <FullScreenVisualizer />
                    </div>
                )}
            </AnimatePresence>
            <ContextMenuController.Root />
        </>
    );
};
