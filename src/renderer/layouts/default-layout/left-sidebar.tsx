import { lazy, Suspense, useRef } from 'react';

import styles from './left-sidebar.module.css';

import { ResizeHandle } from '/@/renderer/features/shared/components/resize-handle';
import { useIsTabletRange } from '/@/renderer/hooks/use-breakpoint';
import { useAppStore } from '/@/renderer/store';

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
     * Tablet-range override — at 768–834px the desktop shell renders
     * but the stored 260px+ sidebar is far too wide for the viewport,
     * so the rail is forced to its 80px collapsed form. Resize handle
     * is suppressed too: dragging it open at this width would just put
     * the user back where they came from once they navigated.
     *
     * Mirrors the same override in main-content.tsx.
     */
    const isTabletRange = useIsTabletRange();
    const collapsed = isTabletRange ? true : storedCollapsed;

    return (
        <aside className={styles.container} id="sidebar">
            {!isTabletRange && (
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
