import { useInView } from 'motion/react';
import { RefObject, useEffect, useMemo } from 'react';

import { useWindowSettings } from '/@/renderer/store/settings.store';
import { Platform } from '/@/shared/types/types';

export const useStickyTableHeader = ({
    containerRef,
    enabled,
    headerRef,
    mainGridRef,
    pinnedLeftColumnRef,
    pinnedRightColumnRef,
    stickyHeaderMainRef,
}: {
    containerRef: RefObject<HTMLDivElement | null>;
    enabled: boolean;
    headerRef: RefObject<HTMLDivElement | null>;
    mainGridRef?: RefObject<HTMLDivElement | null>;
    pinnedLeftColumnRef?: RefObject<HTMLDivElement | null>;
    pinnedRightColumnRef?: RefObject<HTMLDivElement | null>;
    stickyHeaderMainRef?: RefObject<HTMLDivElement | null>;
}) => {
    const { windowBarStyle } = useWindowSettings();

    const topMargin =
        windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS
            ? '-130px'
            : '-100px';

    const isTableHeaderInView = useInView(headerRef, {
        margin: `${topMargin} 0px 0px 0px`,
    });

    const isTableInView = useInView(containerRef, {
        margin: `${topMargin} 0px 0px 0px`,
    });

    const shouldShowStickyHeader = useMemo(() => {
        return enabled && !isTableHeaderInView && isTableInView;
    }, [enabled, isTableHeaderInView, isTableInView]);

    const stickyTop = useMemo(() => {
        return windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS ? 95 : 65;
    }, [windowBarStyle]);

    // Sync scroll between sticky header and main grid/pinned columns
    useEffect(() => {
        if (!shouldShowStickyHeader || !stickyHeaderMainRef?.current || !mainGridRef?.current) {
            return;
        }

        const stickyMainSection = stickyHeaderMainRef.current;
        const mainGrid = mainGridRef.current.childNodes[0] as HTMLDivElement;
        const pinnedLeft = pinnedLeftColumnRef?.current?.childNodes[0] as HTMLDivElement | null;
        const pinnedRight = pinnedRightColumnRef?.current?.childNodes[0] as HTMLDivElement | null;

        if (!mainGrid) {
            return;
        }

        // Sync initial scroll position when sticky header becomes visible
        const syncInitialScroll = () => {
            const scrollLeft = mainGrid.scrollLeft;
            const scrollTop = mainGrid.scrollTop;

            // Sync horizontal scroll position
            stickyMainSection.scrollTo({
                behavior: 'instant',
                left: scrollLeft,
            });

            // Sync vertical scroll position with pinned columns
            if (pinnedLeft) {
                pinnedLeft.scrollTo({
                    behavior: 'instant',
                    top: scrollTop,
                });
            }
            if (pinnedRight) {
                pinnedRight.scrollTo({
                    behavior: 'instant',
                    top: scrollTop,
                });
            }
        };

        // Sync initial position after a frame to ensure elements are ready
        requestAnimationFrame(() => {
            requestAnimationFrame(syncInitialScroll);
        });

        // Compare the destination's current scroll position before writing. The
        // previous re-entrancy flags were set and reset inside this synchronous
        // handler, so they were already `false` by the time the programmatic
        // `scrollTo` fired its own (async) `scroll` event — making them dead
        // code and letting the echo bounce back. Guarding on the actual value
        // skips the redundant write (and the layout it forces) when the target
        // is already where we'd put it, which breaks the feedback loop.
        const syncScroll = (e: Event) => {
            const target = e.currentTarget as HTMLDivElement;
            const scrollLeft = target.scrollLeft;
            const scrollTop = target.scrollTop;

            // Sync horizontal scroll from main grid to sticky header main section
            if (target === mainGrid && stickyMainSection.scrollLeft !== scrollLeft) {
                stickyMainSection.scrollTo({
                    behavior: 'instant',
                    left: scrollLeft,
                });
            }

            // Sync horizontal scroll from sticky header to main grid
            if (target === stickyMainSection && mainGrid.scrollLeft !== scrollLeft) {
                mainGrid.scrollTo({
                    behavior: 'instant',
                    left: scrollLeft,
                });
            }

            // Sync vertical scroll from main grid to pinned columns
            if (target === mainGrid) {
                if (pinnedLeft && pinnedLeft.scrollTop !== scrollTop) {
                    pinnedLeft.scrollTo({
                        behavior: 'instant',
                        top: scrollTop,
                    });
                }
                if (pinnedRight && pinnedRight.scrollTop !== scrollTop) {
                    pinnedRight.scrollTo({
                        behavior: 'instant',
                        top: scrollTop,
                    });
                }
            }

            // Sync vertical scroll from pinned columns to main grid
            if (pinnedLeft && target === pinnedLeft && mainGrid.scrollTop !== scrollTop) {
                mainGrid.scrollTo({
                    behavior: 'instant',
                    top: scrollTop,
                });
            }

            if (pinnedRight && target === pinnedRight && mainGrid.scrollTop !== scrollTop) {
                mainGrid.scrollTo({
                    behavior: 'instant',
                    top: scrollTop,
                });
            }
        };

        mainGrid.addEventListener('scroll', syncScroll);
        stickyMainSection.addEventListener('scroll', syncScroll);
        if (pinnedLeft) {
            pinnedLeft.addEventListener('scroll', syncScroll);
        }
        if (pinnedRight) {
            pinnedRight.addEventListener('scroll', syncScroll);
        }

        return () => {
            mainGrid.removeEventListener('scroll', syncScroll);
            stickyMainSection.removeEventListener('scroll', syncScroll);
            if (pinnedLeft) {
                pinnedLeft.removeEventListener('scroll', syncScroll);
            }
            if (pinnedRight) {
                pinnedRight.removeEventListener('scroll', syncScroll);
            }
        };
    }, [
        shouldShowStickyHeader,
        mainGridRef,
        pinnedLeftColumnRef,
        pinnedRightColumnRef,
        stickyHeaderMainRef,
    ]);

    return {
        shouldShowStickyHeader,
        stickyTop,
    };
};
