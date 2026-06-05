import { useEffect } from 'react';

interface UseStickyHeaderPositioningProps {
    containerRef: React.RefObject<HTMLDivElement | null>;
    shouldShowStickyHeader: boolean;
    stickyHeaderRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * Hook to update the position and width of the sticky header based on container position.
 * Scroll synchronization is handled separately in useStickyTableHeader.
 */
export const useStickyHeaderPositioning = ({
    containerRef,
    shouldShowStickyHeader,
    stickyHeaderRef,
}: UseStickyHeaderPositioningProps) => {
    useEffect(() => {
        if (!shouldShowStickyHeader || !stickyHeaderRef.current || !containerRef.current) {
            return;
        }

        const stickyHeader = stickyHeaderRef.current;
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
            if (!isMounted || !stickyHeader || !container) {
                return;
            }
            try {
                const containerRect = container.getBoundingClientRect();
                if (containerRect.left !== lastLeft) {
                    lastLeft = containerRect.left;
                    stickyHeader.style.left = `${containerRect.left}px`;
                }
                if (containerRect.width !== lastWidth) {
                    lastWidth = containerRect.width;
                    stickyHeader.style.width = `${containerRect.width}px`;
                }
            } catch {
                // Silently handle errors if elements are no longer in DOM
            }
        };

        const scheduleUpdate = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(applyPosition);
        };

        // Run an initial synchronous positioning so the header doesn't flash
        // mispositioned for a frame.
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
    }, [containerRef, shouldShowStickyHeader, stickyHeaderRef]);
};
