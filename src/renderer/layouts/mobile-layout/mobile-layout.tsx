import clsx from 'clsx';
import { AnimatePresence } from 'motion/react';
import { Suspense } from 'react';
import { Outlet } from 'react-router';

import styles from './mobile-layout.module.css';

import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { FullScreenVisualizer } from '/@/renderer/features/player/components/full-screen-visualizer';
import { MobileFullscreenPlayer } from '/@/renderer/features/player/components/mobile-fullscreen-player';
import { RouteSkeleton } from '/@/renderer/features/shared/components/route-skeleton';
import { MobileSidebar } from '/@/renderer/features/sidebar/components/mobile-sidebar';
import { PlayerBar } from '/@/renderer/layouts/default-layout/player-bar';
import { BottomTabBar } from '/@/renderer/layouts/mobile-layout/bottom-tab-bar';
import { WindowBar } from '/@/renderer/layouts/window-bar';
import { useFullScreenPlayerOverlayState, useWindowBarStyle } from '/@/renderer/store';
import { Drawer } from '/@/shared/components/drawer/drawer';
import { useDisclosure } from '/@/shared/hooks/use-disclosure';
import { Platform } from '/@/shared/types/types';

interface MobileLayoutProps {
    shell?: boolean;
}

export const MobileLayout = ({ shell }: MobileLayoutProps) => {
    const [sidebarOpened, { close: closeSidebar, open: openSidebar }] = useDisclosure(false);
    const {
        expanded: isFullScreenPlayerExpanded,
        visualizerExpanded: isFullScreenVisualizerExpanded,
    } = useFullScreenPlayerOverlayState();
    const windowBarStyle = useWindowBarStyle();

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
                <main className={styles.mainContent}>
                    <Suspense fallback={<RouteSkeleton />}>
                        <Outlet />
                    </Suspense>
                </main>
                <PlayerBar />
                <BottomTabBar
                    drawerOpen={sidebarOpened}
                    onMoreTab={sidebarOpened ? closeSidebar : openSidebar}
                />
            </div>
            <Drawer
                onClose={closeSidebar}
                opened={sidebarOpened}
                position="left"
                size="320px"
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
                <MobileSidebar />
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
