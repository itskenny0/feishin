import { useEffect } from 'react';

interface UseStickyGroupRowPositioningProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
    shouldRenderStickyGroupRow: boolean;
    stickyGroupRowRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Hook to update the position and width of the sticky group row based on container position.
 */
export const useStickyGroupRowPositioning = ({
    containerRef,
    shouldRenderStickyGroupRow,
    stickyGroupRowRef,
}: UseStickyGroupRowPositioningProps) => {
    useEffect(() => {
        if (!shouldRenderStickyGroupRow || !stickyGroupRowRef.current || !containerRef.current) {
            return;
        }

        const stickyGroupRow = stickyGroupRowRef.current;
        const container = containerRef.current;
        let isMounted = true;
        let rafId: null | number = null;
        // Cache last-written values so we skip redundant style writes (which
        // force layout) when the container position/width hasn't changed.
        let lastLeft = NaN;
        let lastWidth = NaN;

        // Coalesce the read (getBoundingClientRect) + write (style) into a
        // single rAF so a burst of scroll events does at most one layout-read
        // and one paint per frame instead of one synchronous read-then-write
        // per event.
        const applyPosition = () => {
            rafId = null;
            if (!isMounted || !stickyGroupRow || !container) {
                return;
            }
            try {
                const containerRect = container.getBoundingClientRect();
                if (containerRect.left !== lastLeft) {
                    lastLeft = containerRect.left;
                    stickyGroupRow.style.left = `${containerRect.left}px`;
                }
                if (containerRect.width !== lastWidth) {
                    lastWidth = containerRect.width;
                    stickyGroupRow.style.width = `${containerRect.width}px`;
                }
            } catch {
                // Silently handle errors if elements are no longer in DOM
            }
        };

        const scheduleUpdate = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(applyPosition);
        };

        applyPosition();

        window.addEventListener('resize', scheduleUpdate, { passive: true });
        window.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });

        return () => {
            isMounted = false;
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            window.removeEventListener('resize', scheduleUpdate);
            window.removeEventListener('scroll', scheduleUpdate, true);
        };
    }, [containerRef, shouldRenderStickyGroupRow, stickyGroupRowRef]);
};
