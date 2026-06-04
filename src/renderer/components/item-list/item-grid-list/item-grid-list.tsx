import clsx from 'clsx';
import throttle from 'lodash/throttle';
import { motion } from 'motion/react';
import { useOverlayScrollbars } from 'overlayscrollbars-react';
import React, {
    CSSProperties,
    memo,
    ReactNode,
    Ref,
    RefObject,
    useCallback,
    useEffect,
    useImperativeHandle,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import AutoSizer from 'react-virtualized-auto-sizer';
import {
    FixedSizeList,
    ListChildComponentProps,
    ListOnItemsRenderedProps,
    ListOnScrollProps,
} from 'react-window';

import styles from './item-grid-list.module.css';

import {
    getDataRows,
    getDataRowsCount,
    ItemCard,
    ItemCardProps,
} from '/@/renderer/components/item-card/item-card';
import { createExtractRowId } from '/@/renderer/components/item-list/helpers/extract-row-id';
import { isRangeSelectableItem } from '/@/renderer/components/item-list/helpers/is-range-selectable-item';
import { useDefaultItemListControls } from '/@/renderer/components/item-list/helpers/item-list-controls';
import {
    ItemListStateActions,
    ItemListStateItemWithRequiredProperties,
    useItemListState,
} from '/@/renderer/components/item-list/helpers/item-list-state';
import { useListHotkeys } from '/@/renderer/components/item-list/helpers/use-list-hotkeys';
import { ItemControls, ItemListHandle } from '/@/renderer/components/item-list/types';
import {
    useGridCardCornerRadius,
    useGridCardSize,
    useGridGap,
    useGridMetadataRows,
    useShowRatingBadge,
} from '/@/renderer/store';
import { animationProps } from '/@/shared/components/animations/animation-props';
import { useElementSize } from '/@/shared/hooks/use-element-size';
import { useFocusWithin } from '/@/shared/hooks/use-focus-within';
import { useMergedRef } from '/@/shared/hooks/use-merged-ref';
import { LibraryItem } from '/@/shared/types/domain-types';

export type GridCardCornerRadius = 'pill' | 'rounded-lg' | 'rounded-md' | 'rounded-sm' | 'square';

/**
 * Maps the user-facing grid-card corner-radius setting onto a CSS length the
 * cards consume via the `--card-corner-radius` custom property. 'rounded-md'
 * resolves to `--theme-radius-md`, reproducing the hardcoded look the cards
 * shipped with, so the default is a no-op.
 */
export const GRID_CARD_CORNER_RADIUS_VALUE: Record<GridCardCornerRadius, string> = {
    pill: 'var(--theme-radius-pill)',
    'rounded-lg': 'var(--theme-radius-lg)',
    'rounded-md': 'var(--theme-radius-md)',
    'rounded-sm': 'var(--theme-radius-sm)',
    square: '0px',
};

interface VirtualizedGridListProps {
    _tableMetaVersion: number; // Used to trigger rerenders via React.memo comparison
    cardCornerRadius: GridCardCornerRadius;
    controls: ItemControls;
    currentPage?: number;
    dataVersion?: number;
    enableDrag?: boolean;
    enableExpansion: boolean;
    enableMultiSelect: boolean;
    enableSelection: boolean;
    gap: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    getItem?: (index: number) => ItemCardProps['data'];
    height: number;
    initialTop?: ItemGridListProps['initialTop'];
    internalState: ItemListStateActions;
    itemCount: number;
    itemType: LibraryItem;
    onRangeChanged?: ItemGridListProps['onRangeChanged'];
    onScroll?: ItemGridListProps['onScroll'];
    onScrollEnd?: ItemGridListProps['onScrollEnd'];
    outerRef: RefObject<any>;
    ref: RefObject<FixedSizeList<GridItemProps> | null>;
    rows?: ItemCardProps['rows'];
    showRatingBadge: boolean;
    size?: 'compact' | 'default' | 'large';
    tableMetaRef: RefObject<null | {
        columnCount: number;
        itemHeight: number;
        rowCount: number;
    }>;
    width: number;
}

const VirtualizedGridList = React.memo(
    ({
        cardCornerRadius,
        controls,
        currentPage,
        dataVersion,
        enableDrag,
        enableExpansion,
        enableMultiSelect,
        enableSelection,
        gap,
        getItem,
        height,
        initialTop,
        internalState,
        itemCount,
        itemType,
        onRangeChanged,
        onScroll,
        onScrollEnd,
        outerRef,
        ref,
        rows,
        showRatingBadge,
        size,
        tableMetaRef,
        width,
    }: VirtualizedGridListProps) => {
        const tableMeta = tableMetaRef.current;
        const scrollEndTimeoutRef = useRef<NodeJS.Timeout | null>(null);
        const isInitialScrollRef = useRef(true);
        const initialScrollOffsetRef = useRef<null | number>(null);

        const itemData: GridItemProps = useMemo(() => {
            return {
                cardCornerRadius,
                columns: tableMeta?.columnCount || 0,
                controls,
                dataVersion,
                enableDrag,
                enableExpansion,
                enableMultiSelect,
                enableSelection,
                gap,
                getItem,
                internalState,
                itemCount,
                itemType,
                rows,
                showRatingBadge,
                size,
                tableMeta,
            };
        }, [
            tableMeta,
            cardCornerRadius,
            controls,
            rows,
            getItem,
            itemCount,
            dataVersion,
            enableDrag,
            enableExpansion,
            enableMultiSelect,
            enableSelection,
            gap,
            internalState,
            itemType,
            showRatingBadge,
            size,
        ]);

        const handleOnScroll = useCallback(
            ({ scrollDirection, scrollOffset }: ListOnScrollProps) => {
                onScroll?.(scrollOffset, scrollDirection === 'forward' ? 'down' : 'up');

                if (isInitialScrollRef.current) {
                    if (initialScrollOffsetRef.current === null) {
                        initialScrollOffsetRef.current = scrollOffset;
                        return;
                    } else if (Math.abs(initialScrollOffsetRef.current - scrollOffset) < 1) {
                        return;
                    }
                    isInitialScrollRef.current = false;
                }

                if (scrollEndTimeoutRef.current) {
                    clearTimeout(scrollEndTimeoutRef.current);
                }

                scrollEndTimeoutRef.current = setTimeout(() => {
                    onScrollEnd?.(scrollOffset, scrollDirection === 'forward' ? 'down' : 'up');
                    scrollEndTimeoutRef.current = null;
                }, 150);
            },
            [onScroll, onScrollEnd],
        );

        useEffect(() => {
            return () => {
                if (scrollEndTimeoutRef.current) {
                    clearTimeout(scrollEndTimeoutRef.current);
                }
            };
        }, []);

        const handleOnItemsRendered = useCallback(
            (items: ListOnItemsRenderedProps) => {
                const columnCount = tableMetaRef.current?.columnCount || 0;
                onRangeChanged?.({
                    startIndex: items.visibleStartIndex * columnCount,
                    stopIndex: items.visibleStopIndex * columnCount,
                });
            },
            [onRangeChanged, tableMetaRef],
        );

        useEffect(() => {
            isInitialScrollRef.current = true;
            initialScrollOffsetRef.current = null;
        }, [initialTop]);

        if (!tableMeta) {
            return null;
        }

        const calculateInitialScrollOffset = (): number => {
            // When page changes, always start at top (ignore initialTop)
            if (currentPage !== undefined) {
                if (currentPage === 0 && initialTop) {
                    if (initialTop.type === 'offset') {
                        return initialTop.to;
                    }
                    const columnCount = tableMeta?.columnCount || 1;
                    const itemHeight = tableMeta?.itemHeight || 0;
                    const rowIndex = Math.floor(initialTop.to / columnCount);
                    return rowIndex * itemHeight;
                }
                return 0;
            }

            if (!initialTop) return 0;

            if (initialTop.type === 'offset') {
                return initialTop.to;
            }

            const columnCount = tableMeta?.columnCount || 1;
            const itemHeight = tableMeta?.itemHeight || 0;
            const rowIndex = Math.floor(initialTop.to / columnCount);
            return rowIndex * itemHeight;
        };

        return (
            <FixedSizeList
                height={height}
                initialScrollOffset={calculateInitialScrollOffset()}
                itemCount={tableMeta.rowCount || 0}
                itemData={itemData}
                itemSize={tableMeta.itemHeight || 0}
                onItemsRendered={handleOnItemsRendered}
                onScroll={handleOnScroll}
                outerRef={outerRef}
                ref={ref}
                width={width}
            >
                {ListComponent}
            </FixedSizeList>
        );
    },
);

VirtualizedGridList.displayName = 'VirtualizedGridList';

/**
 * Maps a measured content width (in px) to the number of grid columns. Keyed
 * on the grid's CONTENT width, not the viewport — in the desktop shell the
 * content area is the viewport minus the sidebar.
 *
 * Tablet content-width tiers: the desktop shell renders for the whole
 * 768-1199 viewport band; with an expanded (240px) sidebar the content area
 * can be as narrow as ~560-700px, which previously fell into the 2-column
 * branch and produced oversized covers on the device class with the most
 * room. Intermediate 3-col (>=540) and 4-col (>=700) steps give tablet content
 * widths a sensible 3-4 columns.
 */
export function getDynamicItemsPerRow(width: number, size?: 'compact' | 'default' | 'large') {
    // Phone tiers (content width < 540 — below the lowest tablet tier).
    //
    // The old tuning collapsed phones to 1 column below 380 and only reached
    // 2 columns up to 540, so a 360-430px phone rendered 1-2 oversized covers
    // and almost nothing fit above the fold. Phones want DENSITY, like the
    // Spotify / Apple Music library grids.
    //
    //   - Small phones (< 384: 320 iPhone SE … 360 Pixel/Android) -> 2 cols.
    //     Two square covers at 360 minus padding leaves ~165px each — a clean,
    //     readable thumbnail rather than one viewport-filling cover.
    //   - Larger phones (384-539: 390 iPhone, 412-430 Pro Max / Android-XL)
    //     -> 3 cols (~120-133px covers), matching the streaming-app density
    //     users expect on a comfortable portrait phone.
    //
    // The >=540 tablet/desktop content-width tiers below are UNCHANGED.
    const isSmallPhone = width < 384;
    const isLargePhone = width < 540;
    const is3col = width >= 540;
    const is4col = width >= 700;
    const isSm = width >= 600;
    const isMd = width >= 768;
    const isLg = width >= 960;
    const isXl = width >= 1200;
    const is2xl = width >= 1440;
    const is3xl = width >= 1920;
    const is4xl = width >= 2560;

    let dynamicItemsPerRow = 2;

    if (is4xl) {
        dynamicItemsPerRow = 10;
    } else if (is3xl) {
        dynamicItemsPerRow = 8;
    } else if (is2xl) {
        dynamicItemsPerRow = 7;
    } else if (isXl) {
        dynamicItemsPerRow = 6;
    } else if (isLg) {
        dynamicItemsPerRow = 5;
    } else if (isMd) {
        dynamicItemsPerRow = 4;
    } else if (is4col) {
        dynamicItemsPerRow = 4;
    } else if (isSm) {
        dynamicItemsPerRow = 3;
    } else if (is3col) {
        dynamicItemsPerRow = 3;
    } else if (isSmallPhone) {
        dynamicItemsPerRow = 2;
    } else if (isLargePhone) {
        dynamicItemsPerRow = 3;
    } else {
        dynamicItemsPerRow = 2;
    }

    if (size === 'large') {
        dynamicItemsPerRow = Math.round(dynamicItemsPerRow * 0.75);
        if (dynamicItemsPerRow < 1) {
            dynamicItemsPerRow = 1;
        }
    }

    return dynamicItemsPerRow;
}

const createThrottledSetTableMeta = (
    itemsPerRow?: number,
    rowsCount?: number,
    size?: 'compact' | 'default' | 'large',
) => {
    return throttle((width: number, dataLength: number, setTableMeta: (meta: any) => void) => {
        const dynamicItemsPerRow = getDynamicItemsPerRow(width, size);

        const setItemsPerRow = itemsPerRow || dynamicItemsPerRow;

        const widthPerItem = Number(width) / setItemsPerRow;
        // For compact size, don't include text lines in height calculation
        // CompactItemCard has a different layout that doesn't need the extra space
        const itemHeight =
            size === 'compact'
                ? widthPerItem
                : widthPerItem + (rowsCount || getDataRowsCount()) * 26;

        if (widthPerItem === 0) {
            return;
        }

        setTableMeta({
            columnCount: setItemsPerRow,
            itemHeight,
            rowCount: Math.ceil(dataLength / setItemsPerRow),
        });
    }, 200);
};

export interface GridItemProps {
    cardCornerRadius: GridCardCornerRadius;
    columns: number;
    controls: ItemCardProps['controls'];
    dataVersion?: number;
    enableDrag?: boolean;
    enableExpansion?: boolean;
    enableMultiSelect: boolean;
    enableSelection?: boolean;
    gap: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    getItem?: (index: number) => ItemCardProps['data'];
    internalState: ItemListStateActions;
    itemCount: number;
    itemType: LibraryItem;
    rows?: ItemCardProps['rows'];
    showRatingBadge: boolean;
    size?: 'compact' | 'default' | 'large';
    tableMeta: null | {
        columnCount: number;
        itemHeight: number;
        rowCount: number;
    };
}

export interface ItemGridListProps {
    currentPage?: number;
    data: unknown[];
    dataVersion?: number;
    enableDrag?: boolean;
    enableEntranceAnimation?: boolean;
    enableExpansion?: boolean;
    enableMultiSelect?: boolean;
    enableSelection?: boolean;
    enableSelectionDialog?: boolean;
    gap?: 'lg' | 'md' | 'sm' | 'xl' | 'xs';
    getItem?: (index: number) => ItemCardProps['data'];
    getItemIndex?: (rowId: string) => number | undefined;
    getRowId?: ((item: unknown) => string) | string;
    initialTop?: {
        to: number;
        type: 'index' | 'offset';
    };
    itemCount?: number;
    itemsPerRow?: number;
    itemType: LibraryItem;
    onRangeChanged?: (range: { startIndex: number; stopIndex: number }) => void;
    onScroll?: (offset: number, direction: 'down' | 'up') => void;
    onScrollEnd?: (offset: number, direction: 'down' | 'up') => void;
    overrideControls?: Partial<ItemControls>;
    ref?: Ref<ItemListHandle>;
    rows?: ItemCardProps['rows'];
    size?: 'compact' | 'default' | 'large';
}

const BaseItemGridList = ({
    currentPage,
    data,
    dataVersion,
    enableDrag = true,
    enableEntranceAnimation = true,
    enableExpansion = false,
    enableMultiSelect = false,
    enableSelection = true,
    gap,
    getItem,
    getItemIndex,
    getRowId,
    initialTop,
    itemCount,
    itemsPerRow,
    itemType,
    onRangeChanged,
    onScroll,
    onScrollEnd,
    overrideControls,
    ref,
    rows,
    size,
}: ItemGridListProps) => {
    // Global grid-display settings. Each defaults to the value that reproduces
    // the card's previously-hardcoded look, so an untouched install renders
    // identically. A per-list override (an explicitly-passed `gap`/`size`/`rows`
    // prop) still wins when present — list consumers pass their configured
    // values, so those remain authoritative; consumers that omit a prop (e.g.
    // home carousels) inherit the global default instead.
    const globalGap = useGridGap();
    const globalSize = useGridCardSize();
    const globalMetadataRows = useGridMetadataRows();
    const globalCornerRadius = useGridCardCornerRadius();
    const globalShowRatingBadge = useShowRatingBadge();

    const resolvedGap = gap ?? globalGap;
    const resolvedSize = size ?? globalSize;
    const cardCornerRadius = globalCornerRadius as GridCardCornerRadius;
    const showRatingBadge = globalShowRatingBadge;

    // When the global metadata-row setting is non-empty it overrides the
    // per-item-type defaults supplied via the `rows` prop. Empty (the default)
    // keeps whatever the caller passed (i.e. getDefaultRowsForItemType).
    const resolvedRows = useMemo<ItemCardProps['rows']>(() => {
        if (!globalMetadataRows || globalMetadataRows.length === 0) {
            return rows;
        }
        const type: 'compact' | 'poster' = resolvedSize === 'compact' ? 'compact' : 'poster';
        const allRows = getDataRows(type);
        const rowMap = new Map(allRows.map((row) => [row.id, row]));
        const picked = globalMetadataRows
            .map((id) => rowMap.get(id))
            .filter((row): row is NonNullable<typeof row> => row !== undefined);
        return picked.length > 0 ? picked : rows;
    }, [globalMetadataRows, resolvedSize, rows]);

    const rootRef = useRef<HTMLDivElement | null>(null);
    const outerRef = useRef<HTMLDivElement | null>(null);
    const listRef = useRef<FixedSizeList<GridItemProps>>(null);
    const { ref: containerRef, width: containerWidth } = useElementSize();
    const { focused, ref: containerFocusRef } = useFocusWithin();
    const handleRef = useRef<ItemListHandle | null>(null);
    const mergedContainerRef = useMergedRef(containerRef, rootRef, containerFocusRef);

    const resolvedItemCount = itemCount ?? data.length;
    const resolvedGetItem = useCallback<(index: number) => ItemCardProps['data']>(
        (index: number) => {
            return (getItem ? getItem(index) : (data as any[])[index]) as ItemCardProps['data'];
        },
        [data, getItem],
    );

    const getDataFn = useCallback(() => {
        return data;
    }, [data]);

    const extractRowId = useMemo(() => createExtractRowId(getRowId), [getRowId]);

    const internalState = useItemListState(getDataFn, extractRowId);

    const [initialize, osInstance] = useOverlayScrollbars({
        defer: false,
        events: {
            initialized(osInstance) {
                const { viewport } = osInstance.elements();
                viewport.style.overflowX = `var(--os-viewport-overflow-x)`;
                viewport.style.overflowY = `var(--os-viewport-overflow-y)`;
            },
        },
        options: {
            overflow: { x: 'hidden', y: 'scroll' },
            paddingAbsolute: true,
            scrollbars: {
                autoHide: 'leave',
                autoHideDelay: 500,
                pointers: ['mouse', 'pen', 'touch'],
                theme: 'feishin-os-scrollbar',
            },
        },
    });

    const tableMetaRef = useRef<null | {
        columnCount: number;
        itemHeight: number;
        rowCount: number;
    }>(null);

    const [tableMetaVersion, setTableMetaVersion] = useState(0);
    const isOverlayScrollbarsInitialized = useRef(false);

    useEffect(() => {
        const { current: root } = rootRef;
        const { current: outer } = outerRef;

        if (!tableMetaRef.current || !root || !outer || isOverlayScrollbarsInitialized.current) {
            return;
        }

        initialize({
            elements: {
                viewport: outer,
            },
            target: root,
        });

        isOverlayScrollbarsInitialized.current = true;
    }, [initialize, tableMetaVersion]);

    useEffect(() => {
        return () => {
            try {
                const instance = osInstance();
                const { current: root } = rootRef;
                const { current: outer } = outerRef;

                // Check if instance exists and elements are still connected to the DOM
                if (instance) {
                    // Check if elements are still in the document
                    const rootInDocument = root && document.contains(root);
                    const outerInDocument = outer && document.contains(outer);

                    // Only destroy if elements are still in the document
                    if (rootInDocument && outerInDocument) {
                        instance.destroy();
                    }
                }
            } catch {
                // Ignore error
            }
        };
    }, [osInstance]);

    const throttledSetTableMeta = useMemo(() => {
        return createThrottledSetTableMeta(itemsPerRow, resolvedRows?.length, resolvedSize);
    }, [itemsPerRow, resolvedRows?.length, resolvedSize]);

    useLayoutEffect(() => {
        const container = rootRef.current;
        if (!container) return;

        throttledSetTableMeta(containerWidth, resolvedItemCount, (meta) => {
            if (!meta) return;

            const current = tableMetaRef.current;
            if (
                !current ||
                current.columnCount !== meta.columnCount ||
                current.itemHeight !== meta.itemHeight ||
                current.rowCount !== meta.rowCount
            ) {
                tableMetaRef.current = meta;
                const el = rootRef.current;
                if (!el) return;
                el.style.setProperty('--grid-column-count', String(meta.columnCount));
                el.style.setProperty('--grid-item-height', `${meta.itemHeight}px`);
                el.style.setProperty('--grid-row-count', String(meta.rowCount));
                setTableMetaVersion((v) => v + 1);
            }
        });
    }, [containerWidth, resolvedItemCount, throttledSetTableMeta]);

    const controls = useDefaultItemListControls({
        enableMultiSelect,
        overrides: overrideControls,
    });

    const scrollToIndex = useCallback(
        (
            index: number,
            options?: { align?: 'bottom' | 'center' | 'top'; behavior?: 'auto' | 'smooth' },
        ) => {
            if (!listRef.current || !tableMetaRef.current) return;
            const row = Math.floor(index / tableMetaRef.current.columnCount);

            // Map alignment options to react-window's alignment
            let alignment: 'auto' | 'center' | 'end' | 'smart' | 'start' = 'smart';
            if (options?.align === 'top') {
                alignment = 'start';
            } else if (options?.align === 'center') {
                alignment = 'center';
            } else if (options?.align === 'bottom') {
                alignment = 'end';
            }

            listRef.current.scrollToItem(row, alignment);
        },
        [],
    );

    const scrollToOffset = useCallback((offset: number) => {
        if (!listRef.current) return;
        listRef.current.scrollTo(offset);
    }, []);

    // Handle keyboard navigation
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (!enableSelection || !tableMetaRef.current) return;
            if (
                e.key !== 'ArrowDown' &&
                e.key !== 'ArrowUp' &&
                e.key !== 'ArrowLeft' &&
                e.key !== 'ArrowRight'
            )
                return;
            e.preventDefault();
            e.stopPropagation();

            const selected = internalState.getSelected();
            let currentIndex = -1;

            if (selected.length > 0) {
                const lastSelected = selected[selected.length - 1];
                const lastRowId = internalState.extractRowId(lastSelected);
                if (lastRowId) {
                    currentIndex =
                        getItemIndex?.(lastRowId) ??
                        data.findIndex((d: any) => {
                            const rowId = internalState.extractRowId(d);
                            return rowId === lastRowId;
                        });
                }
            }

            // Calculate grid position
            const currentRow =
                currentIndex !== -1
                    ? Math.floor(currentIndex / tableMetaRef.current.columnCount)
                    : 0;
            const currentCol =
                currentIndex !== -1 ? currentIndex % tableMetaRef.current.columnCount : 0;
            const totalRows = Math.ceil(resolvedItemCount / tableMetaRef.current.columnCount);

            let newIndex = 0;
            if (currentIndex !== -1) {
                switch (e.key) {
                    case 'ArrowDown': {
                        // Move down one row
                        const nextRow = currentRow + 1;
                        if (nextRow < totalRows) {
                            const nextRowStart = nextRow * tableMetaRef.current.columnCount;
                            const nextRowEnd = Math.min(
                                nextRowStart + tableMetaRef.current.columnCount - 1,
                                resolvedItemCount - 1,
                            );
                            // Keep same column position, or use last item in row if column doesn't exist
                            newIndex = Math.min(nextRowStart + currentCol, nextRowEnd);
                        } else {
                            newIndex = currentIndex;
                        }
                        break;
                    }
                    case 'ArrowLeft': {
                        // Move left, wrap to previous row if at start of row
                        if (currentCol > 0) {
                            newIndex = currentIndex - 1;
                        } else if (currentRow > 0) {
                            // Wrap to end of previous row
                            newIndex = Math.max(
                                (currentRow - 1) * tableMetaRef.current.columnCount +
                                    tableMetaRef.current.columnCount -
                                    1,
                                0,
                            );
                            newIndex = Math.min(newIndex, resolvedItemCount - 1);
                        } else {
                            newIndex = currentIndex;
                        }
                        break;
                    }
                    case 'ArrowRight': {
                        // Move right, wrap to next row if at end of row
                        if (
                            currentCol < tableMetaRef.current.columnCount - 1 &&
                            currentIndex < resolvedItemCount - 1
                        ) {
                            newIndex = currentIndex + 1;
                        } else if (currentRow < totalRows - 1) {
                            // Wrap to start of next row
                            newIndex = Math.min(
                                (currentRow + 1) * tableMetaRef.current.columnCount,
                                resolvedItemCount - 1,
                            );
                        } else {
                            newIndex = currentIndex;
                        }
                        break;
                    }
                    case 'ArrowUp': {
                        // Move up one row
                        const prevRow = currentRow - 1;
                        if (prevRow >= 0) {
                            const prevRowStart = prevRow * tableMetaRef.current.columnCount;
                            const prevRowEnd = Math.min(
                                prevRowStart + tableMetaRef.current.columnCount - 1,
                                resolvedItemCount - 1,
                            );
                            // Keep same column position, or use last item in row if column doesn't exist
                            newIndex = Math.min(prevRowStart + currentCol, prevRowEnd);
                        } else {
                            newIndex = currentIndex;
                        }
                        break;
                    }
                }
            } else {
                // No selection, start at first item
                newIndex = 0;
            }

            const newItem: any = resolvedGetItem(newIndex);
            if (!newItem) return;

            // Handle Shift + Arrow for incremental range selection (matches shift+click behavior)
            if (e.shiftKey) {
                const selectedItems = internalState.getSelected();
                const lastSelectedItem = selectedItems[selectedItems.length - 1];

                if (lastSelectedItem) {
                    // Find the indices of the last selected item and new item
                    const lastRowId = internalState.extractRowId(lastSelectedItem);
                    if (!lastRowId) return;

                    const lastIndex =
                        getItemIndex?.(lastRowId) ??
                        data.findIndex((d: any) => {
                            const rowId = internalState.extractRowId(d);
                            return rowId === lastRowId;
                        });

                    if (lastIndex !== -1 && newIndex !== -1) {
                        // Create range selection from last selected to new position
                        const startIndex = Math.min(lastIndex, newIndex);
                        const stopIndex = Math.max(lastIndex, newIndex);

                        const rangeItems: ItemListStateItemWithRequiredProperties[] = [];
                        for (let i = startIndex; i <= stopIndex; i++) {
                            const rangeItem = resolvedGetItem(i);
                            if (
                                isRangeSelectableItem(rangeItem) &&
                                internalState.extractRowId(rangeItem)
                            ) {
                                rangeItems.push(rangeItem);
                            }
                        }

                        // Add range items to selection (matching shift+click behavior)
                        const currentSelected = internalState.getSelected();
                        const newSelected: ItemListStateItemWithRequiredProperties[] = [
                            ...currentSelected.filter(
                                (item): item is ItemListStateItemWithRequiredProperties =>
                                    typeof item === 'object' && item !== null,
                            ),
                        ];
                        rangeItems.forEach((rangeItem) => {
                            const rangeRowId = internalState.extractRowId(rangeItem);
                            if (
                                rangeRowId &&
                                !newSelected.some(
                                    (selected) =>
                                        internalState.extractRowId(selected) === rangeRowId,
                                )
                            ) {
                                newSelected.push(rangeItem);
                            }
                        });

                        // Ensure the last item in selection is the item at newIndex for incremental extension
                        const newItemListItem = newItem as ItemListStateItemWithRequiredProperties;
                        const newItemRowId = internalState.extractRowId(newItemListItem);
                        if (newItemRowId) {
                            // Remove the new item from its current position if it exists
                            const filteredSelected = newSelected.filter(
                                (item) => internalState.extractRowId(item) !== newItemRowId,
                            );
                            // Add it at the end so it becomes the last selected item
                            filteredSelected.push(newItemListItem);
                            internalState.setSelected(filteredSelected);
                        }
                    }
                } else {
                    // No previous selection, just select the new item
                    const newItemListItem = newItem as ItemListStateItemWithRequiredProperties;
                    if (internalState.extractRowId(newItemListItem)) {
                        internalState.setSelected([newItemListItem]);
                    }
                }
            } else {
                // Without Shift: select only the new item
                const newItemListItem = newItem as ItemListStateItemWithRequiredProperties;
                if (internalState.extractRowId(newItemListItem)) {
                    internalState.setSelected([newItemListItem]);
                }
            }

            scrollToIndex(newIndex);
        },
        [
            data,
            enableSelection,
            getItemIndex,
            internalState,
            resolvedGetItem,
            resolvedItemCount,
            scrollToIndex,
        ],
    );

    const imperativeHandle: ItemListHandle = useMemo(() => {
        return {
            internalState,
            scrollToIndex: (index: number, options?: { align?: 'bottom' | 'center' | 'top' }) => {
                scrollToIndex(index, options);
            },
            scrollToOffset: (offset: number) => {
                scrollToOffset(offset);
            },
        };
    }, [internalState, scrollToIndex, scrollToOffset]);

    useEffect(() => {
        handleRef.current = imperativeHandle;
    }, [imperativeHandle]);

    useImperativeHandle(ref, () => imperativeHandle, [imperativeHandle]);

    useListHotkeys({
        controls,
        focused,
        internalState,
        itemType,
    });

    return (
        <motion.div
            className={styles.itemGridContainer}
            data-overlayscrollbars-initialize=""
            onKeyDown={handleKeyDown}
            onMouseDown={(e) => (e.currentTarget as HTMLDivElement).focus()}
            ref={mergedContainerRef}
            tabIndex={0}
            {...animationProps.fadeIn}
            transition={{ duration: enableEntranceAnimation ? 0.5 : 0, ease: 'anticipate' }}
        >
            <AutoSizer>
                {({ height, width }) => (
                    <VirtualizedGridList
                        _tableMetaVersion={tableMetaVersion}
                        cardCornerRadius={cardCornerRadius}
                        controls={controls}
                        currentPage={currentPage}
                        dataVersion={dataVersion}
                        enableDrag={enableDrag}
                        enableExpansion={enableExpansion}
                        enableMultiSelect={enableMultiSelect}
                        enableSelection={enableSelection}
                        gap={resolvedGap}
                        getItem={resolvedGetItem}
                        height={height}
                        initialTop={initialTop}
                        internalState={internalState}
                        itemCount={resolvedItemCount}
                        itemType={itemType}
                        onRangeChanged={onRangeChanged}
                        onScroll={onScroll ?? (() => {})}
                        onScrollEnd={onScrollEnd ?? (() => {})}
                        outerRef={outerRef}
                        ref={listRef}
                        rows={resolvedRows}
                        showRatingBadge={showRatingBadge}
                        size={resolvedSize}
                        tableMetaRef={tableMetaRef}
                        width={width}
                    />
                )}
            </AutoSizer>
        </motion.div>
    );
};

const ListComponent = memo((props: ListChildComponentProps<GridItemProps>) => {
    const { index, style } = props;
    const {
        cardCornerRadius,
        columns,
        controls,
        enableDrag,
        enableMultiSelect,
        gap,
        getItem,
        itemCount,
        itemType,
        rows,
        showRatingBadge,
        size,
    } = props.data;

    const cornerRadiusValue = GRID_CARD_CORNER_RADIUS_VALUE[cardCornerRadius];

    const items: ReactNode[] = [];
    const startIndex = index * columns;
    const stopIndex = Math.min(itemCount - 1, startIndex + columns - 1);

    const columnCountInRow = stopIndex - startIndex + 1;

    let columnCountToAdd = 0;

    if (columnCountInRow !== columns) {
        columnCountToAdd = columns - columnCountInRow;
    }

    for (let i = startIndex; i <= stopIndex + columnCountToAdd; i += 1) {
        if (i < itemCount) {
            const item = getItem ? getItem(i) : undefined;
            items.push(
                <div
                    className={clsx(styles.itemRow, styles[`gap-${gap}`])}
                    key={`card-${i}-${index}`}
                    style={
                        {
                            '--card-corner-radius': cornerRadiusValue,
                            '--columns': columns,
                        } as CSSProperties
                    }
                >
                    <ItemCard
                        controls={controls}
                        data={item}
                        enableDrag={enableDrag}
                        enableExpansion={props.data.enableExpansion}
                        enableMultiSelect={enableMultiSelect}
                        imageAsLink={!enableMultiSelect}
                        internalState={props.data.internalState}
                        itemType={itemType}
                        rows={rows}
                        showRatingBadge={showRatingBadge}
                        type={size === 'compact' ? 'compact' : 'poster'}
                        withControls
                    />
                </div>,
            );
        } else {
            items.push(null);
        }
    }

    return (
        <div className={styles.itemList} style={style}>
            {items}
        </div>
    );
});

export const ItemGridList = memo(BaseItemGridList);

ItemGridList.displayName = 'ItemGridList';
