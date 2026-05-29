import { useMediaQuery } from '@mantine/hooks';
import { lazy, Suspense, useRef } from 'react';

import styles from './left-sidebar.module.css';

import { ResizeHandle } from '/@/renderer/features/shared/components/resize-handle';
import { useAppStore } from '/@/renderer/store';

/*
 * Force-collapse band for the desktop shell. The desktop shell renders for
 * the whole 768–1199px "tablet" tier, but the stored expanded sidebar
 * (260px+, clamped to 240px by CSS at 835–1280) starves the main content —
 * at 835–960px the library grid drops to 2 oversized columns purely because
 * the sidebar ate the width. Forcing the 80px rail across the entire tablet
 * tier (not just 768–834 as before) keeps the content area wide enough for a
 * sensible 3–4 column grid. Above 1199px (desktop tier) the stored sidebar
 * comes back. Kept identical in main-content.tsx.
 */
const TABLET_SHELL_QUERY = '(min-width: 768px) and (max-width: 1199px)';

const CollapsedSidebar = lazy(() =>
    import('/@/renderer/features/sidebar/components/collapsed-sidebar').then((module) => ({
        default: module.CollapsedSidebar,
    })),
);

const Sidebar = lazy(() =>
    import('/@/renderer/features/sidebar/components/sidebar').then((module) => ({
        default: module.Sidebar,
    })),
);

interface LeftSidebarProps {
    isResizing: boolean;
    startResizing: (direction: 'left' | 'right', mouseEvent?: MouseEvent) => void;
}

export const LeftSidebar = ({ isResizing, startResizing }: LeftSidebarProps) => {
    const sidebarRef = useRef<HTMLDivElement | null>(null);
    const storedCollapsed = useAppStore((state) => state.sidebar.collapsed);
    /*
     * Tablet-shell override — across the whole 768–1199px desktop-shell
     * tablet tier the stored 260px+ sidebar is too wide for the viewport,
     * so the rail is forced to its 80px collapsed form. Resize handle is
     * suppressed too: dragging it open at this width would just put the
     * user back where they came from once they navigated.
     *
     * Mirrors the same override in main-content.tsx.
     */
    const isTabletShell = useMediaQuery(TABLET_SHELL_QUERY);
    const collapsed = isTabletShell ? true : storedCollapsed;

    return (
        <aside className={styles.container} id="sidebar">
            {!isTabletShell && (
                <ResizeHandle
                    isResizing={isResizing}
                    // pointerdown (not mousedown) so the gesture fires on touch
                    // devices too. preventDefault stops the browser from
                    // hijacking the gesture as a scroll on touch.
                    onPointerDown={(e) => {
                        e.preventDefault();
                        startResizing('left');
                    }}
                    placement="right"
                    ref={sidebarRef}
                />
            )}
            <Suspense fallback={<></>}>{collapsed ? <CollapsedSidebar /> : <Sidebar />}</Suspense>
        </aside>
    );
};
