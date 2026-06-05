import { memo, useMemo } from 'react';

import styles from './list-skeleton.module.css';

import { getDynamicItemsPerRow } from '/@/renderer/components/item-list/helpers/grid-layout';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { useElementSize } from '/@/shared/hooks/use-element-size';

/**
 * Content-shaped loading skeletons for the library LIST routes (albums,
 * artists, album-artists, playlists, genres, songs).
 *
 * These replace the previous `<Spinner container />` Suspense fallback so the
 * content area paints a layout-shaped placeholder while the inner grid/table
 * chunk + count/first-page data queries resolve. The route header/toolbar is
 * outside the suspense boundary and already paints synchronously, so only the
 * content area is reserved here.
 *
 * Zero layout shift is the whole point:
 *   - GRID: the skeleton measures its OWN content width and derives the column
 *     count from the exact same `getDynamicItemsPerRow` the real grid uses, so
 *     the placeholder cards land on the same column grid the data will. Cover
 *     placeholders are square (`aspect-ratio: 1`) matching the poster cards,
 *     with 1–2 text lines below to mirror `useGridRows` defaults.
 *   - TABLE: a header strip (optional) plus compact rows at the real row height
 *     (compact 40 / default 64 / large 88), matching `item-table-list`.
 */

const SKELETON_RADIUS_SM = 'var(--theme-radius-sm)';

type GridSize = 'compact' | 'default' | 'large';
interface ListGridSkeletonProps {
    /** Render circular cover placeholders (artists / album-artists). */
    circular?: boolean;
    /** Force a specific column count (mirrors the grid's `itemsPerRow` override). */
    columns?: number;
    /** Grid gap — controls cell padding so the cell pitch matches the real grid. */
    gap?: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    /** Number of text lines below each cover (album = 2, most others = 1). */
    rows?: number;
    /** Card sizing tier passed to `getDynamicItemsPerRow`. */
    size?: GridSize;
}

type TableSize = 'compact' | 'default' | 'large';

const ROW_HEIGHT_BY_SIZE: Record<TableSize, number> = {
    compact: 40,
    default: 64,
    large: 88,
};

const TABLE_HEADER_HEIGHT = 40;

/**
 * Grid-of-covers skeleton. Measures its own width and uses
 * `getDynamicItemsPerRow` so the column count matches the live grid exactly,
 * then fills the available height with cover-card placeholders.
 */
export const ListGridSkeleton = memo(
    ({
        circular = false,
        columns,
        gap = 'md',
        rows = 1,
        size = 'default',
    }: ListGridSkeletonProps) => {
        const { height, ref, width } = useElementSize();

        const columnCount = useMemo(() => {
            if (columns && columns > 0) {
                return columns;
            }
            if (!width) {
                return 0;
            }
            return getDynamicItemsPerRow(width, size);
        }, [columns, size, width]);

        const cardCount = useMemo(() => {
            if (!columnCount || !width) {
                return 0;
            }
            const cellWidth = width / columnCount;
            // Poster cards add `rows * 26px` of text height; compact cards are
            // square. Estimate cell height so we render just enough rows to
            // cover the viewport (plus one) — matching the real virtualized
            // grid's initial fill without overdrawing.
            const textHeight = size === 'compact' ? 0 : rows * 26;
            const cellHeight = cellWidth + textHeight;
            const usableHeight = height || 800;
            const rowsToRender = Math.max(1, Math.ceil(usableHeight / cellHeight) + 1);
            return rowsToRender * columnCount;
        }, [columnCount, height, rows, size, width]);

        return (
            <div aria-hidden className={styles.gridRoot} ref={ref} role="presentation">
                {columnCount > 0 && (
                    <div
                        className={styles.gridList}
                        style={{ ['--skeleton-columns' as string]: String(columnCount) }}
                    >
                        {Array.from({ length: cardCount }).map((_, index) => (
                            <div className={styles[`cell-gap-${gap}`]} key={index}>
                                <div className={styles.card}>
                                    <Skeleton
                                        borderRadius={circular ? '50%' : SKELETON_RADIUS_SM}
                                        className={styles.cover}
                                        enableAnimation
                                    />
                                    <Skeleton
                                        borderRadius={SKELETON_RADIUS_SM}
                                        enableAnimation
                                        height={13}
                                        width="80%"
                                    />
                                    {rows > 1 && (
                                        <Skeleton
                                            borderRadius={SKELETON_RADIUS_SM}
                                            enableAnimation
                                            height={11}
                                            width="55%"
                                        />
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        );
    },
);

ListGridSkeleton.displayName = 'ListGridSkeleton';

interface ListTableSkeletonProps {
    /** Render a header strip above the rows (matches `enableHeader`). */
    enableHeader?: boolean;
    /** Row height tier — matches `item-table-list` (compact 40 / default 64 / large 88). */
    size?: TableSize;
}

/**
 * Compact-row skeleton for table list surfaces (songs default to TABLE). Fills
 * the available height with rows at the real row height so the swap to the
 * virtualized table does not jump.
 */
export const ListTableSkeleton = memo(
    ({ enableHeader = true, size = 'default' }: ListTableSkeletonProps) => {
        const { height, ref } = useElementSize();
        const rowHeight = ROW_HEIGHT_BY_SIZE[size];

        const rowCount = useMemo(() => {
            const usableHeight = (height || 800) - (enableHeader ? TABLE_HEADER_HEIGHT : 0);
            return Math.max(1, Math.ceil(usableHeight / rowHeight) + 1);
        }, [enableHeader, height, rowHeight]);

        return (
            <div aria-hidden className={styles.tableRoot} ref={ref} role="presentation">
                {enableHeader && (
                    <div className={styles.tableHeader} style={{ height: TABLE_HEADER_HEIGHT }}>
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            enableAnimation
                            height={12}
                            width="18%"
                        />
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            enableAnimation
                            height={12}
                            width="12%"
                        />
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            enableAnimation
                            height={12}
                            width="10%"
                        />
                    </div>
                )}
                {Array.from({ length: rowCount }).map((_, index) => (
                    <div className={styles.tableRow} key={index} style={{ height: rowHeight }}>
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            className={styles.rowThumb}
                            enableAnimation
                        />
                        <Skeleton
                            borderRadius={SKELETON_RADIUS_SM}
                            enableAnimation
                            height={13}
                            width={`${30 + ((index * 7) % 25)}%`}
                        />
                    </div>
                ))}
            </div>
        );
    },
);

ListTableSkeleton.displayName = 'ListTableSkeleton';
