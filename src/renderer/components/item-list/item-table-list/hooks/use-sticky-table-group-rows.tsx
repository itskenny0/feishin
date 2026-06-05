import { useInView } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';

import { useWindowSettings } from '/@/renderer/store/settings.store';
import { Platform } from '/@/shared/types/types';

export interface GroupRowInfo {
    groupIndex: number;
    rowIndex: number;
}

export const useStickyTableGroupRows = ({
    containerRef,
    enabled,
    getRowHeight,
    groups,
    headerHeight,
    mainGridRef,
    shouldShowStickyHeader,
    stickyHeaderTop,
}: {
    containerRef: React.RefObject<HTMLDivElement | null>;
    enabled: boolean;
    getRowHeight: (index: number) => number;
    groups?: Array<{ itemCount: number }>;
    headerHeight: number;
    mainGridRef: React.RefObject<HTMLDivElement | null>;
    shouldShowStickyHeader?: boolean;
    stickyHeaderTop?: number;
}) => {
    const { windowBarStyle } = useWindowSettings();
    const [stickyGroupIndex, setStickyGroupIndex] = useState<null | number>(null);

    const topMargin =
        windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS
            ? '-130px'
            : '-100px';

    const isTableInView = useInView(containerRef, {
        margin: `${topMargin} 0px 0px 0px`,
    });

    const stickyTop = useMemo(() => {
        // If sticky header is showing, position group row below it with 1px offset to avoid conflict
        // Otherwise, use the base sticky position
        if (shouldShowStickyHeader && stickyHeaderTop !== undefined) {
            return stickyHeaderTop + headerHeight + 1;
        }
        return windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS ? 95 : 65;
    }, [windowBarStyle, shouldShowStickyHeader, stickyHeaderTop, headerHeight]);

    // Calculate group row indexes
    const groupRowIndexes = useMemo(() => {
        if (!groups || groups.length === 0) {
            return [];
        }

        const indexes: GroupRowInfo[] = [];
        let cumulativeDataIndex = 0;
        const headerOffset = 1; // Assuming header is enabled

        groups.forEach((group, groupIndex) => {
            const groupHeaderIndex = headerOffset + cumulativeDataIndex + groupIndex;
            indexes.push({
                groupIndex,
                rowIndex: groupHeaderIndex,
            });
            cumulativeDataIndex += group.itemCount;
        });

        return indexes;
    }, [groups]);

    // Precompute, once per [groups/heights] change, each group row's absolute
    // top offset (from the top of the grid, including the header) and its own
    // height. Previously the scroll handler re-summed getRowHeight() for every
    // row before every group on every scroll tick — O(groups x rowIndex) per
    // event. We now walk the rows a single time here and index straight into
    // the precomputed values during scroll.
    const groupRowOffsets = useMemo(() => {
        if (groupRowIndexes.length === 0) {
            return [] as Array<{ groupIndex: number; rowHeight: number; rowTop: number }>;
        }

        const offsets: Array<{ groupIndex: number; rowHeight: number; rowTop: number }> = [];
        // Walk rows from 0 up to the last group row index exactly once, keeping
        // a running cumulative offset (starting after the header). For each
        // group row we record its top and height as we reach it.
        let cumulative = headerHeight;
        let nextGroup = 0;
        const maxRowIndex = groupRowIndexes[groupRowIndexes.length - 1].rowIndex;

        for (let r = 0; r <= maxRowIndex && nextGroup < groupRowIndexes.length; r++) {
            const target = groupRowIndexes[nextGroup];
            if (r === target.rowIndex) {
                const rowHeight = getRowHeight(r);
                offsets.push({
                    groupIndex: target.groupIndex,
                    rowHeight,
                    rowTop: cumulative,
                });
                cumulative += rowHeight;
                nextGroup++;
            } else {
                cumulative += getRowHeight(r);
            }
        }

        return offsets;
    }, [groupRowIndexes, getRowHeight, headerHeight]);

    useEffect(() => {
        if (
            !enabled ||
            !groups ||
            groups.length === 0 ||
            !mainGridRef.current ||
            !containerRef.current
        ) {
            return;
        }

        // Get the actual scrollable grid element (first child of the container)
        const mainGridContainer = mainGridRef.current;
        const mainGrid = mainGridContainer.childNodes[0] as HTMLDivElement | null;

        if (!mainGrid) {
            return;
        }

        let rafId: null | number = null;

        const computeStickyGroup = () => {
            rafId = null;

            const scrollTop = mainGrid.scrollTop || 0;
            const containerRect = containerRef.current?.getBoundingClientRect();

            if (!containerRect) {
                return;
            }

            // Calculate the sticky threshold position
            // The sticky group row should appear when a group row scrolls past this position
            // stickyTop already accounts for window bar style and sticky header offset
            const containerTop = containerRect.top;
            const baseStickyPosition = stickyTop; // Base position (window bar + sticky header if showing)

            // Find which group row should be sticky
            // We want to show the current group as soon as its row reaches the sticky position
            // This way it updates "on scroll" when scrolling into a new group section
            let targetGroupIndex: null | number = null;

            // Iterate forward through the precomputed group-row offsets to find
            // which one is at or about to reach the sticky position. No per-row
            // height re-summing here — `rowTop`/`rowHeight` are precomputed.
            for (let i = 0; i < groupRowOffsets.length; i++) {
                const { groupIndex, rowHeight: groupRowHeight, rowTop } = groupRowOffsets[i];

                // Calculate where this row would be in the viewport (absolute position from top of viewport)
                const rowViewportTop = containerTop + rowTop - scrollTop;

                // Calculate the sticky position accounting for the sticky group row's own height
                // Similar to how stickyTop accounts for sticky header height, we add the group row height
                const stickyPosition = baseStickyPosition + groupRowHeight;

                // Check if this group row has reached or is about to reach the sticky position
                // The sticky group row appears at baseStickyPosition, but we check when the actual group row
                // reaches baseStickyPosition + groupRowHeight to account for the sticky group row's own height
                if (rowViewportTop <= stickyPosition) {
                    // This group has reached the sticky position, so show this group
                    targetGroupIndex = groupIndex;
                    // Don't break here - continue checking to see if a later group should replace it
                } else {
                    // This group hasn't reached the sticky position yet
                    // If we already found a target group, keep it and stop
                    // Otherwise, no group should be sticky yet
                    if (targetGroupIndex !== null) {
                        break;
                    }
                }
            }

            setStickyGroupIndex((prev) => {
                if (prev !== targetGroupIndex) {
                    return targetGroupIndex;
                }
                return prev;
            });
        };

        // Coalesce a burst of scroll/resize events into a single read+state
        // update per frame.
        const updateStickyGroup = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(computeStickyGroup);
        };

        computeStickyGroup();

        mainGrid.addEventListener('scroll', updateStickyGroup, { passive: true });
        window.addEventListener('scroll', updateStickyGroup, { capture: true, passive: true });
        window.addEventListener('resize', updateStickyGroup, { passive: true });

        return () => {
            if (rafId !== null) {
                cancelAnimationFrame(rafId);
                rafId = null;
            }
            mainGrid.removeEventListener('scroll', updateStickyGroup);
            window.removeEventListener('scroll', updateStickyGroup, true);
            window.removeEventListener('resize', updateStickyGroup);
        };
    }, [enabled, groups, groupRowOffsets, mainGridRef, containerRef, stickyTop]);

    const shouldShowStickyGroupRow = useMemo(() => {
        return enabled && stickyGroupIndex !== null && isTableInView;
    }, [enabled, stickyGroupIndex, isTableInView]);

    return {
        shouldShowStickyGroupRow,
        stickyGroupIndex,
        stickyTop,
    };
};
