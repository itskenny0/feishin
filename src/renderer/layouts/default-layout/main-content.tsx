import { useMediaQuery } from '@mantine/hooks';
import clsx from 'clsx';
import { motion } from 'motion/react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Outlet } from 'react-router';
import { shallow } from 'zustand/shallow';

import styles from './main-content.module.css';

import { ExpandedListContainer } from '/@/renderer/components/item-list/expanded-list-container';
import { ExpandedListItem } from '/@/renderer/components/item-list/expanded-list-item';
import { RouteSkeleton } from '/@/renderer/features/shared/components/route-skeleton';
import { ScrollToTopButton } from '/@/renderer/features/shared/components/scroll-to-top-button';
import { useIsTabletRange } from '/@/renderer/hooks/use-breakpoint';
import { FullScreenOverlay } from '/@/renderer/layouts/default-layout/full-screen-overlay';
import { FullScreenVisualizerOverlay } from '/@/renderer/layouts/default-layout/full-screen-visualizer-overlay';
import { LeftSidebar } from '/@/renderer/layouts/default-layout/left-sidebar';
import { RightSidebar } from '/@/renderer/layouts/default-layout/right-sidebar';
import {
    useAppStore,
    useAppStoreActions,
    useGlobalExpanded,
    useSideQueueLayout,
    useSideQueueType,
} from '/@/renderer/store';
import { constrainRightSidebarWidth, constrainSidebarWidth } from '/@/renderer/utils';

/*
 * Force-collapse band for the desktop shell — the whole 768–1199px tablet
 * tier. See left-sidebar.tsx for the rationale (kept in sync there). This is
 * wider than `useIsTabletRange` (768–834) on purpose: the queue-sidebar
 * suppression + tablet-shell class below intentionally stay at 768–834,
 * because 835–1280 already floats the queue as an overlay and clamps the
 * sidebar to 240px in CSS. Only the left-rail force-collapse widens.
 */
const TABLET_SHELL_QUERY = '(min-width: 768px) and (max-width: 1199px)';

const MINIMUM_SIDEBAR_WIDTH = 300;

export const MainContent = ({ shell }: { shell?: boolean }) => {
    const {
        collapsed: storedCollapsed,
        leftWidth,
        rightExpanded: storedRightExpanded,
        rightHeight,
        rightWidth,
    } = useAppStore(
        (state) => ({
            collapsed: state.sidebar.collapsed,
            leftWidth: state.sidebar.leftWidth,
            rightExpanded: state.sidebar.rightExpanded,
            rightHeight: state.sidebar.rightHeight,
            rightWidth: state.sidebar.rightWidth,
        }),
        shallow,
    );
    /*
     * Two overlapping tablet overrides, kept separate on purpose:
     *
     *  - isTabletShell (768–1199): force the left sidebar to its 80px rail
     *    across the entire desktop-shell tablet tier so the stored 260px+
     *    sidebar never starves the main content (2-col grid bug at 835–960).
     *
     *  - isTabletRange (768–834): additionally suppress the right (queue)
     *    sidebar entirely — at this narrow width even an overlay queue is
     *    cramped. From 835–1280 the queue floats as a dismissible overlay
     *    (handled in right-sidebar + CSS) so it is NOT suppressed there.
     *
     * The store is left alone — only the render-time overrides flip — so
     * when the viewport leaves the tablet tier the user's original desktop
     * preferences come back without a side-effect on mount.
     */
    const isTabletShell = useMediaQuery(TABLET_SHELL_QUERY);
    const isTabletRange = useIsTabletRange();
    const collapsed = isTabletShell ? true : storedCollapsed;
    const rightExpanded = isTabletRange ? false : storedRightExpanded;
    const { setSideBar } = useAppStoreActions();
    const sideQueueType = useSideQueueType();
    const sideQueueLayout = useSideQueueLayout();
    const [isResizing, setIsResizing] = useState(false);
    const [isResizingRight, setIsResizingRight] = useState(false);

    const rightSidebarRef = useRef<HTMLDivElement | null>(null);
    const mainContentRef = useRef<HTMLDivElement | null>(null);
    const initialRightWidthRef = useRef<string>(rightWidth);
    const initialRightHeightRef = useRef<string>(rightHeight);
    const initialMouseXRef = useRef<number>(0);
    const initialMouseYRef = useRef<number>(0);
    const wasCollapsedDuringDragRef = useRef<boolean>(false);

    useEffect(() => {
        if (mainContentRef.current && !isResizing && !isResizingRight) {
            // The live drag clamps widths, but the PERSISTED value is applied
            // verbatim here — installs carrying a pre-clamp (or corrupted)
            // leftWidth rendered a sidebar grid column far wider than the nav
            // it contains, swallowing the content area (Windows, 2026-06-11).
            // Sanitize persisted values through the same constraints.
            const leftPx = Number.parseInt(leftWidth, 10);
            const safeLeft = Number.isFinite(leftPx)
                ? `${constrainSidebarWidth(leftPx)}px`
                : '400px';
            const rightPx = Number.parseInt(rightWidth, 10);
            const safeRight = Number.isFinite(rightPx)
                ? `${constrainRightSidebarWidth(rightPx)}px`
                : rightWidth;
            mainContentRef.current.style.setProperty('--sidebar-width', safeLeft);
            mainContentRef.current.style.setProperty('--right-sidebar-width', safeRight);
            mainContentRef.current.style.setProperty('--right-sidebar-height', rightHeight);
            initialRightWidthRef.current = safeRight;
            initialRightHeightRef.current = rightHeight;
        }
    }, [leftWidth, rightWidth, rightHeight, isResizing, isResizingRight]);

    const startResizing = useCallback(
        (position: 'left' | 'right' | 'top', mouseEvent?: MouseEvent) => {
            if (position === 'left') {
                setIsResizing(true);
                wasCollapsedDuringDragRef.current = false;
            } else {
                setIsResizingRight(true);
                if (mainContentRef.current && rightSidebarRef.current && mouseEvent) {
                    if (position === 'top') {
                        const currentHeight =
                            mainContentRef.current.style.getPropertyValue('--right-sidebar-height');
                        if (currentHeight) {
                            initialRightHeightRef.current = currentHeight;
                        } else {
                            initialRightHeightRef.current = rightHeight;
                        }
                        initialMouseYRef.current = mouseEvent.clientY;
                    } else {
                        const currentWidth =
                            mainContentRef.current.style.getPropertyValue('--right-sidebar-width');
                        if (currentWidth) {
                            initialRightWidthRef.current = currentWidth;
                        } else {
                            initialRightWidthRef.current = rightWidth;
                        }
                        initialMouseXRef.current = mouseEvent.clientX;
                    }
                } else {
                    if (position === 'top') {
                        initialRightHeightRef.current = rightHeight;
                    } else {
                        initialRightWidthRef.current = rightWidth;
                    }
                }
            }
        },
        [rightHeight, rightWidth],
    );

    const stopResizing = useCallback(() => {
        if (isResizing && mainContentRef.current) {
            if (!wasCollapsedDuringDragRef.current) {
                const finalWidth = mainContentRef.current.style.getPropertyValue('--sidebar-width');
                if (finalWidth) {
                    setSideBar({ collapsed: false, leftWidth: finalWidth });
                }
            }
            setIsResizing(false);
            wasCollapsedDuringDragRef.current = false;
        } else if (isResizingRight && mainContentRef.current) {
            if (sideQueueLayout === 'vertical') {
                const finalHeight =
                    mainContentRef.current.style.getPropertyValue('--right-sidebar-height');
                if (finalHeight) {
                    setSideBar({ rightHeight: finalHeight });
                }
            } else {
                const finalWidth =
                    mainContentRef.current.style.getPropertyValue('--right-sidebar-width');
                if (finalWidth) {
                    setSideBar({ rightWidth: finalWidth });
                }
            }
            setIsResizingRight(false);
        }
    }, [isResizing, isResizingRight, setSideBar, sideQueueLayout]);

    const resize = useCallback(
        (mouseMoveEvent: any) => {
            if (!mainContentRef.current) return;

            if (isResizing) {
                const width = mouseMoveEvent.clientX;
                const constrainedWidthValue = constrainSidebarWidth(width);
                const constrainedWidth = `${constrainedWidthValue}px`;

                if (width < MINIMUM_SIDEBAR_WIDTH - 100) {
                    if (!wasCollapsedDuringDragRef.current) {
                        wasCollapsedDuringDragRef.current = true;
                        setSideBar({ collapsed: true });
                    }
                } else {
                    if (wasCollapsedDuringDragRef.current) {
                        wasCollapsedDuringDragRef.current = false;
                        setSideBar({ collapsed: false });
                    }
                    mainContentRef.current.style.setProperty('--sidebar-width', constrainedWidth);
                }
            } else if (isResizingRight) {
                if (sideQueueLayout === 'vertical') {
                    const initialHeight = Number(initialRightHeightRef.current.split('px')[0]);
                    const initialMouseY = initialMouseYRef.current;
                    const deltaY = mouseMoveEvent.clientY - initialMouseY;
                    const containerHeight = mainContentRef.current.clientHeight;
                    const minHeight = 220;
                    const maxHeight = Math.max(minHeight, containerHeight - 200);
                    const newHeight = initialHeight - deltaY;
                    const clampedHeight = Math.min(Math.max(newHeight, minHeight), maxHeight);
                    mainContentRef.current.style.setProperty(
                        '--right-sidebar-height',
                        `${clampedHeight}px`,
                    );
                } else {
                    const initialWidth = Number(initialRightWidthRef.current.split('px')[0]);
                    const initialMouseX = initialMouseXRef.current;
                    const deltaX = mouseMoveEvent.clientX - initialMouseX;
                    const newWidth = initialWidth - deltaX;
                    const width = `${constrainRightSidebarWidth(newWidth)}px`;
                    mainContentRef.current.style.setProperty('--right-sidebar-width', width);
                }
            }
        },
        [isResizing, isResizingRight, setSideBar, sideQueueLayout],
    );

    useEffect(() => {
        if (!isResizing && !isResizingRight) {
            return;
        }

        // pointer* events fire for mouse + touch + pen uniformly; mouse*
        // doesn't fire (or fires unreliably) for touch in the Android
        // Capacitor WebView, which is why drag-to-resize did nothing on
        // tablets even with widened hit zones. The resize() callback only
        // reads clientX / clientY, which PointerEvent has the same as
        // MouseEvent — no other change needed.
        window.addEventListener('pointermove', resize);
        window.addEventListener('pointerup', stopResizing);
        window.addEventListener('pointercancel', stopResizing);

        return () => {
            window.removeEventListener('pointermove', resize);
            window.removeEventListener('pointerup', stopResizing);
            window.removeEventListener('pointercancel', stopResizing);
        };
    }, [isResizing, isResizingRight, resize, stopResizing]);

    return (
        <motion.div
            className={clsx(styles.mainContentContainer, {
                [styles.rightExpanded]: rightExpanded && sideQueueType === 'sideQueue',
                [styles.shell]: shell,
                [styles.sidebarCollapsed]: collapsed,
                [styles.sidebarExpanded]: !collapsed,
                [styles.tabletShell]: isTabletRange,
                [styles.verticalLayout]:
                    rightExpanded &&
                    sideQueueType === 'sideQueue' &&
                    sideQueueLayout === 'vertical',
            })}
            id="main-content"
            ref={mainContentRef}
        >
            {!shell && (
                <>
                    <FullScreenVisualizerOverlay />
                    <FullScreenOverlay />
                    <LeftSidebar isResizing={isResizing} startResizing={startResizing} />
                    {/*
                     * Suppress the right (queue) sidebar render entirely
                     * in the tablet sweet-spot. RightSidebar normally
                     * reads `rightExpanded` from the store itself, so
                     * the parent override above doesn't reach it — we
                     * just skip mounting it in this range. The user's
                     * stored desktop preference is untouched.
                     */}
                    {!isTabletRange && (
                        <RightSidebar
                            isResizing={isResizingRight}
                            ref={rightSidebarRef}
                            startResizing={startResizing}
                        />
                    )}
                </>
            )}
            <MainContentBody />
        </motion.div>
    );
};

function GlobalExpandedPanel() {
    const globalExpanded = useGlobalExpanded();

    if (!globalExpanded) return null;

    return (
        <ExpandedListContainer>
            <ExpandedListItem item={globalExpanded.item} itemType={globalExpanded.itemType} />
        </ExpandedListContainer>
    );
}

function MainContentBody() {
    // Ref points at the body's scrollable container. The
    // ScrollToTopButton attaches a capture-phase scroll listener so
    // it also fires for descendant overflow containers (e.g. the
    // virtualised lists in albums / songs / search results).
    const scrollRef = useRef<HTMLDivElement | null>(null);

    return (
        <main className={styles.mainContentBody}>
            <div className={styles.mainContentBodyScroll} ref={scrollRef}>
                <Suspense fallback={<RouteSkeleton />}>
                    <Outlet />
                </Suspense>
            </div>
            <ScrollToTopButton targetRef={scrollRef} />
            <GlobalExpandedPanel />
        </main>
    );
}
