import clsx from 'clsx';
import { AnimatePresence } from 'motion/react';
import { Fragment, memo, ReactNode, useCallback, useMemo, useRef, useState } from 'react';
import { generatePath, Link, useNavigate } from 'react-router';

import styles from './item-card.module.css';

import i18n from '/@/i18n/i18n';
import { ItemCardControls } from '/@/renderer/components/item-card/item-card-controls';
import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { getDraggedItems } from '/@/renderer/components/item-list/helpers/get-dragged-items';
import { getTitlePath } from '/@/renderer/components/item-list/helpers/get-title-path';
import {
    ItemListStateActions,
    useItemDraggingState,
    useItemSelectionState,
} from '/@/renderer/components/item-list/helpers/item-list-state';
import { ItemControls } from '/@/renderer/components/item-list/types';
import { JoinedArtists } from '/@/renderer/features/albums/components/joined-artists';
import { useDragDrop } from '/@/renderer/hooks/use-drag-drop';
import { useLongPress } from '/@/renderer/hooks/use-long-press';
import { prefetchAlbumDetail, preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { useShowFilesystemNameForAlbums, useShowRatings } from '/@/renderer/store';
import {
    formatDateAbsolute,
    formatDateRelative,
    formatDurationString,
    formatPartialIsoDateUTC,
    formatRating,
} from '/@/renderer/utils/format';
import { SEPARATOR_STRING } from '/@/shared/api/utils';
import { ExplicitIndicator } from '/@/shared/components/explicit-indicator/explicit-indicator';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Separator } from '/@/shared/components/separator/separator';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Text } from '/@/shared/components/text/text';
import { useDoubleClick } from '/@/shared/hooks/use-double-click';
import {
    Album,
    AlbumArtist,
    Artist,
    Genre,
    LibraryItem,
    Playlist,
    Song,
} from '/@/shared/types/domain-types';
import { DragOperation, DragTarget } from '/@/shared/types/drag-and-drop';
import { Play } from '/@/shared/types/types';
import { stringToColor } from '/@/shared/utils/string-to-color';

export type DataRow = {
    align?: 'center' | 'end' | 'start';
    format: (
        data: Album | AlbumArtist | Artist | Genre | Playlist | Song,
    ) => null | ReactNode | string;
    id: string;
    isMuted?: boolean;
};

export interface ItemCardProps {
    controls?: ItemControls;
    data: Album | AlbumArtist | Artist | Genre | Playlist | Song | undefined;
    enableDrag?: boolean;
    enableExpansion?: boolean;
    enableMultiSelect?: boolean;
    enableNavigation?: boolean;
    imageAsLink?: boolean;
    imageFetchPriority?: 'auto' | 'high' | 'low';
    internalState?: ItemListStateActions;
    isRound?: boolean;
    itemType: LibraryItem;
    rows?: DataRow[];
    /**
     * Whether the user-rating star badge may render in the image corner.
     * Defaults to true, reproducing the always-on behavior; the library grid
     * threads the `showRatingBadge` setting through here.
     */
    showRatingBadge?: boolean;
    type?: 'compact' | 'default' | 'poster';
    withControls?: boolean;
}

export const ItemCard = ({
    controls,
    data,
    enableDrag,
    enableExpansion,
    enableMultiSelect,
    enableNavigation = true,
    imageAsLink,
    imageFetchPriority,
    internalState,
    isRound,
    itemType,
    rows: providedRows,
    showRatingBadge = true,
    type = 'poster',
    withControls,
}: ItemCardProps) => {
    const showRatings = useShowRatings();
    const imageUrl = getImageUrl(data);
    const rows = providedRows || [];

    switch (type) {
        case 'compact':
            return (
                <MemoizedCompactItemCard
                    controls={controls}
                    data={data}
                    enableDrag={enableDrag}
                    enableExpansion={enableExpansion}
                    enableMultiSelect={enableMultiSelect}
                    enableNavigation={enableNavigation}
                    imageAsLink={imageAsLink}
                    imageFetchPriority={imageFetchPriority}
                    imageUrl={imageUrl}
                    internalState={internalState}
                    isRound={isRound}
                    itemType={itemType}
                    rows={rows}
                    showRating={showRatings}
                    showRatingBadge={showRatingBadge}
                    withControls={withControls}
                />
            );
        case 'poster':
            return (
                <MemoizedPosterItemCard
                    controls={controls}
                    data={data}
                    enableDrag={enableDrag}
                    enableExpansion={enableExpansion}
                    enableMultiSelect={enableMultiSelect}
                    enableNavigation={enableNavigation}
                    imageAsLink={imageAsLink}
                    imageFetchPriority={imageFetchPriority}
                    imageUrl={imageUrl}
                    internalState={internalState}
                    isRound={isRound}
                    itemType={itemType}
                    rows={rows}
                    showRating={showRatings}
                    showRatingBadge={showRatingBadge}
                    withControls={withControls}
                />
            );
        case 'default':
        default:
            return (
                <MemoizedDefaultItemCard
                    controls={controls}
                    data={data}
                    enableDrag={enableDrag}
                    enableExpansion={enableExpansion}
                    enableNavigation={enableNavigation}
                    imageAsLink={imageAsLink}
                    imageFetchPriority={imageFetchPriority}
                    imageUrl={imageUrl}
                    internalState={internalState}
                    isRound={isRound}
                    itemType={itemType}
                    rows={rows}
                    showRating={showRatings}
                    showRatingBadge={showRatingBadge}
                    withControls={withControls}
                />
            );
    }
};

export interface ItemCardDerivativeProps extends Omit<ItemCardProps, 'type'> {
    controls?: ItemControls;
    enableExpansion?: boolean;
    enableNavigation?: boolean;
    imageAsLink?: boolean;
    imageFetchPriority?: 'auto' | 'high' | 'low';
    imageUrl: string | undefined;
    internalState?: ItemListStateActions;
    rows: DataRow[];
    showRating: boolean;
    showRatingBadge: boolean;
}

type ItemCardData = NonNullable<ItemCardProps['data']>;

const ItemCardStandardImageArea = memo(function ItemCardStandardImageArea({
    controls,
    data,
    enableExpansion,
    enableImageViewport = true,
    enableNavigation,
    handleContextMenu,
    handleImageClick,
    handleLinkDragStart,
    imageAsLink,
    imageFetchPriority,
    internalState,
    isRound,
    itemType,
    navigationPath,
    showRating,
    showRatingBadge = true,
    variant,
    withControls,
}: {
    controls?: ItemControls;
    data: ItemCardData;
    enableExpansion?: boolean;
    enableImageViewport?: boolean;
    enableNavigation?: boolean;
    handleContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
    handleImageClick: (e: React.MouseEvent<HTMLElement>) => void;
    handleLinkDragStart: (e: React.DragEvent<HTMLAnchorElement>) => void;
    imageAsLink?: boolean;
    imageFetchPriority?: 'auto' | 'high' | 'low';
    internalState?: ItemListStateActions;
    isRound?: boolean;
    itemType: LibraryItem;
    navigationPath: null | string;
    showRating: boolean;
    showRatingBadge?: boolean;
    variant: 'default' | 'poster';
    withControls?: boolean;
}) {
    const [showControls, setShowControls] = useState(false);
    const navigate = useNavigate();

    const handleMouseEnter = () => {
        if (withControls) {
            setShowControls(true);
        }
    };

    const handleMouseLeave = () => {
        if (withControls) {
            setShowControls(false);
        }
    };

    const imageContainerClassName = clsx(styles.imageContainer, {
        [styles.isRound]: isRound,
    });

    // When the card renders as a navigation <Link> (no internalState — the home
    // carousels / pinned-style surfaces), this is the branch that turns a touch
    // tap into navigation explicitly. The bare <Link> default click is
    // unreliable inside the Android WebView (the gesture pipeline can swallow
    // the synthesised click after a tap), so on touch we navigate from the
    // long-press hook's onPress instead. Long-press opens the item's context
    // menu via the existing handleContextMenu → controls.onMore path.
    const isLinkBranch = !!enableNavigation && !!navigationPath && (imageAsLink ?? !internalState);

    // A touch tap fires both the long-press hook's onPress (which navigates)
    // and, a moment later, the browser-synthesised click on the <Link> (which
    // would navigate AGAIN, pushing a duplicate history entry). Swallow that
    // one trailing click so back-navigation isn't doubled. Desktop never sets
    // this (useLongPress ignores mouse pointers) so the native click path is
    // untouched there.
    const suppressNextClickRef = useRef(false);

    const longPressHandlers = useLongPress({
        onLongPress: (event) => handleContextMenu(event as React.MouseEvent<HTMLElement>),
        onPress: () => {
            if (isLinkBranch && navigationPath) {
                suppressNextClickRef.current = true;
                navigate(navigationPath, { state: { item: data } });
                return;
            }
            // Non-link cards (e.g. Home song shelves) have no detail route, so
            // a touch tap on the cover plays the item instead of navigating.
            // The bare onClick path is inert on these cards (it needs the
            // internalState the carousels don't pass), so this is the ONLY
            // touch entry point.
            if (data && triggerCardTapPlay(controls, data, itemType, internalState)) {
                suppressNextClickRef.current = true;
            }
        },
    });

    // Capture-phase guard: swallow both the post-long-press click (handled by
    // the hook) AND the post-onPress duplicate-navigation click. Capture runs
    // before React Router's <Link> onClick, so preventDefault here stops the
    // native navigation cleanly.
    const handleAreaClickCapture = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            longPressHandlers.onClickCapture(event);
        },
        [longPressHandlers],
    );

    const isFavorite = 'userFavorite' in data && (data as { userFavorite: boolean }).userFavorite;
    const userRating =
        'userRating' in data &&
        typeof (data as { userRating: null | number }).userRating === 'number'
            ? (data as { userRating: null | number }).userRating
            : null;
    const hasRating = showRatingBadge && showRating && userRating !== null && userRating > 0;

    const imageContainerContent = (
        <>
            {itemType === LibraryItem.GENRE &&
            data &&
            'name' in data &&
            typeof (data as Genre).name === 'string' ? (
                <GenreImagePlaceholder
                    className={clsx(styles.image, styles.genrePlaceholder, {
                        [styles.isRound]: isRound,
                    })}
                    name={(data as Genre).name}
                />
            ) : (
                <ItemImage
                    className={clsx(styles.image, { [styles.isRound]: isRound })}
                    enableDebounce={false}
                    {...(variant === 'poster' ? { enableViewport: enableImageViewport } : {})}
                    explicitStatus={'explicitStatus' in data && data ? data.explicitStatus : null}
                    fetchPriority={imageFetchPriority}
                    id={(data as { imageId?: string })?.imageId}
                    itemType={itemType}
                    src={(data as { imageUrl?: string })?.imageUrl}
                    type="itemCard"
                />
            )}
            {isFavorite && <div className={styles.favoriteBadge} />}
            {hasRating && <div className={styles.ratingBadge}>{userRating}</div>}
            <AnimatePresence>
                {withControls && showControls && (
                    <ItemCardControls
                        controls={controls}
                        enableExpansion={enableExpansion}
                        {...(variant === 'poster' ? { internalState } : {})}
                        item={data}
                        itemType={itemType}
                        showRating={showRating}
                        type={variant}
                    />
                )}
            </AnimatePresence>
        </>
    );

    return isLinkBranch ? (
        <Link
            className={imageContainerClassName}
            draggable={false}
            onClick={handleImageClick}
            onClickCapture={handleAreaClickCapture}
            onContextMenu={handleContextMenu}
            onContextMenuCapture={longPressHandlers.onContextMenuCapture}
            onDragStart={handleLinkDragStart}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerCancel={longPressHandlers.onPointerCancel}
            onPointerDown={longPressHandlers.onPointerDown}
            onPointerMove={longPressHandlers.onPointerMove}
            onPointerUp={longPressHandlers.onPointerUp}
            state={{ item: data }}
            to={navigationPath as string}
        >
            {imageContainerContent}
        </Link>
    ) : (
        <div
            className={imageContainerClassName}
            onClick={handleImageClick}
            onClickCapture={handleAreaClickCapture}
            onContextMenu={handleContextMenu}
            onContextMenuCapture={longPressHandlers.onContextMenuCapture}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerCancel={longPressHandlers.onPointerCancel}
            onPointerDown={longPressHandlers.onPointerDown}
            onPointerMove={longPressHandlers.onPointerMove}
            onPointerUp={longPressHandlers.onPointerUp}
        >
            {imageContainerContent}
        </div>
    );
});

ItemCardStandardImageArea.displayName = 'ItemCardStandardImageArea';

const CompactItemCardImageArea = memo(function CompactItemCardImageArea({
    controls,
    data,
    enableExpansion,
    enableNavigation,
    handleContextMenu,
    handleImageClick,
    handleLinkDragStart,
    imageAsLink,
    imageFetchPriority,
    internalState,
    isRound,
    itemType,
    navigationPath,
    rows,
    showRating,
    showRatingBadge = true,
    withControls,
}: {
    controls?: ItemControls;
    data: ItemCardData;
    enableExpansion?: boolean;
    enableNavigation?: boolean;
    handleContextMenu: (e: React.MouseEvent<HTMLElement>) => void;
    handleImageClick: (e: React.MouseEvent<HTMLElement>) => void;
    handleLinkDragStart: (e: React.DragEvent<HTMLAnchorElement>) => void;
    imageAsLink?: boolean;
    imageFetchPriority?: 'auto' | 'high' | 'low';
    internalState?: ItemListStateActions;
    isRound?: boolean;
    itemType: LibraryItem;
    navigationPath: null | string;
    rows: DataRow[];
    showRating: boolean;
    showRatingBadge?: boolean;
    withControls?: boolean;
}) {
    const [showControls, setShowControls] = useState(false);
    const navigate = useNavigate();

    const handleMouseEnter = () => {
        if (withControls) {
            setShowControls(true);
        }
    };

    const handleMouseLeave = () => {
        if (withControls) {
            setShowControls(false);
        }
    };

    const imageContainerClassName = clsx(styles.imageContainer, {
        [styles.isRound]: isRound,
    });

    // See ItemCardStandardImageArea: explicit touch tap → navigate (Android
    // WebView swallows the bare <Link> tap click), long-press → context menu.
    const isLinkBranch = !!enableNavigation && !!navigationPath && (imageAsLink ?? !internalState);

    const suppressNextClickRef = useRef(false);

    const longPressHandlers = useLongPress({
        onLongPress: (event) => handleContextMenu(event as React.MouseEvent<HTMLElement>),
        onPress: () => {
            if (isLinkBranch && navigationPath) {
                suppressNextClickRef.current = true;
                navigate(navigationPath, { state: { item: data } });
                return;
            }
            // Non-link cards (e.g. Home song shelves) have no detail route, so
            // a touch tap on the cover plays the item instead of navigating.
            // The bare onClick path is inert on these cards (it needs the
            // internalState the carousels don't pass), so this is the ONLY
            // touch entry point.
            if (data && triggerCardTapPlay(controls, data, itemType, internalState)) {
                suppressNextClickRef.current = true;
            }
        },
    });

    const handleAreaClickCapture = useCallback(
        (event: React.MouseEvent<HTMLElement>) => {
            if (suppressNextClickRef.current) {
                suppressNextClickRef.current = false;
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            longPressHandlers.onClickCapture(event);
        },
        [longPressHandlers],
    );

    const isFavorite = 'userFavorite' in data && (data as { userFavorite: boolean }).userFavorite;
    const userRating =
        'userRating' in data &&
        typeof (data as { userRating: null | number }).userRating === 'number'
            ? (data as { userRating: null | number }).userRating
            : null;
    const hasRating = showRatingBadge && showRating && userRating !== null && userRating > 0;

    const imageContainerContent = (
        <>
            {itemType === LibraryItem.GENRE &&
            data &&
            'name' in data &&
            typeof (data as Genre).name === 'string' ? (
                <GenreImagePlaceholder
                    className={clsx(styles.image, styles.genrePlaceholder, {
                        [styles.isRound]: isRound,
                    })}
                    name={(data as Genre).name}
                />
            ) : (
                <ItemImage
                    className={clsx(styles.image, {
                        [styles.isRound]: isRound,
                    })}
                    enableDebounce={false}
                    explicitStatus={'explicitStatus' in data && data ? data.explicitStatus : null}
                    fetchPriority={imageFetchPriority}
                    id={data?.imageId}
                    itemType={itemType}
                    src={(data as Album | AlbumArtist | Playlist | Song)?.imageUrl}
                    type="itemCard"
                />
            )}
            {isFavorite && <div className={styles.favoriteBadge} />}
            {hasRating && <div className={styles.ratingBadge}>{userRating}</div>}
            <AnimatePresence>
                {withControls && showControls && data && (
                    <ItemCardControls
                        controls={controls}
                        enableExpansion={enableExpansion}
                        internalState={internalState}
                        item={data}
                        itemType={itemType}
                        showRating={showRating}
                        type="compact"
                    />
                )}
            </AnimatePresence>
            <div className={clsx(styles.detailContainer, styles.compact)}>
                {rows
                    .filter(
                        (row): row is NonNullable<typeof row> => row !== null && row !== undefined,
                    )
                    .map((row, index) => (
                        <ItemCardRow
                            data={data!}
                            index={index}
                            key={row.id}
                            row={row}
                            type="compact"
                        />
                    ))}
            </div>
        </>
    );

    return isLinkBranch ? (
        <Link
            className={imageContainerClassName}
            draggable={false}
            onClick={handleImageClick}
            onClickCapture={handleAreaClickCapture}
            onContextMenu={handleContextMenu}
            onContextMenuCapture={longPressHandlers.onContextMenuCapture}
            onDragStart={handleLinkDragStart}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerCancel={longPressHandlers.onPointerCancel}
            onPointerDown={longPressHandlers.onPointerDown}
            onPointerMove={longPressHandlers.onPointerMove}
            onPointerUp={longPressHandlers.onPointerUp}
            state={{ item: data }}
            to={navigationPath as string}
        >
            {imageContainerContent}
        </Link>
    ) : (
        <div
            className={imageContainerClassName}
            onClick={handleImageClick}
            onClickCapture={handleAreaClickCapture}
            onContextMenu={handleContextMenu}
            onContextMenuCapture={longPressHandlers.onContextMenuCapture}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onPointerCancel={longPressHandlers.onPointerCancel}
            onPointerDown={longPressHandlers.onPointerDown}
            onPointerMove={longPressHandlers.onPointerMove}
            onPointerUp={longPressHandlers.onPointerUp}
        >
            {imageContainerContent}
        </div>
    );
});

CompactItemCardImageArea.displayName = 'CompactItemCardImageArea';

const CompactItemCard = ({
    controls,
    data,
    enableDrag,
    enableExpansion,
    enableMultiSelect,
    enableNavigation,
    imageAsLink,
    imageFetchPriority,
    internalState,
    isRound,
    itemType,
    rows,
    showRating,
    showRatingBadge,
    withControls,
}: ItemCardDerivativeProps) => {
    const itemRowId =
        data && internalState && typeof data === 'object' && 'id' in data
            ? internalState.extractRowId(data)
            : undefined;
    const isSelected = useItemSelectionState(internalState, itemRowId || undefined);

    const getId = useCallback(() => {
        if (!data) {
            return [];
        }

        const draggedItems = getDraggedItems(data, internalState, enableMultiSelect !== false);
        return draggedItems.map((item) => item.id);
    }, [data, internalState, enableMultiSelect]);

    const getItem = useCallback(() => {
        if (!data) {
            return [];
        }

        const draggedItems = getDraggedItems(data, internalState, enableMultiSelect !== false);
        return draggedItems;
    }, [data, internalState, enableMultiSelect]);

    const onDragStart = useCallback(() => {
        if (!data) {
            return;
        }

        const draggedItems = getDraggedItems(data, internalState, enableMultiSelect !== false);
        if (internalState) {
            internalState.setDragging(draggedItems);
        }
    }, [data, internalState, enableMultiSelect]);

    const onDrop = useCallback(() => {
        if (internalState) {
            internalState.setDragging([]);
        }
    }, [internalState]);

    const dragOperation = useMemo(
        () =>
            itemType === LibraryItem.QUEUE_SONG
                ? [DragOperation.REORDER, DragOperation.ADD]
                : [DragOperation.ADD],
        [itemType],
    );

    const drag = useMemo(
        () => ({
            getId,
            getItem,
            itemType,
            onDragStart,
            onDrop,
            operation: dragOperation,
            target: DragTarget.ALBUM,
        }),
        [getId, getItem, itemType, onDragStart, onDrop, dragOperation],
    );

    const { isDragging: isDraggingLocal, ref } = useDragDrop<HTMLDivElement>({
        drag,
        isEnabled: !!enableDrag && !!data,
    });

    const itemId = data && internalState ? data.id : undefined;
    const isDraggingState = useItemDraggingState(internalState, itemId);
    const isDragging = isDraggingState || isDraggingLocal;

    const handleClick = useDoubleClick({
        onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
            if (!data || !controls || !internalState) {
                return;
            }

            controls.onDoubleClick?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        },
        onSingleClick: (e: React.MouseEvent<HTMLDivElement>) => {
            if (!data || !controls || !internalState) {
                return;
            }

            // Don't trigger selection if clicking on interactive elements
            const target = e.target as HTMLElement;
            const isInteractiveElement = target.closest(
                'button, a, input, select, textarea, [role="button"]',
            );

            if (isInteractiveElement) {
                return;
            }

            controls.onClick?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        },
    });

    if (data) {
        const navigationPath = getItemNavigationPath(data, itemType);

        const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
            if (!data || !controls) {
                return;
            }

            e.preventDefault();

            controls.onMore?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        };

        const handleImageClick = (e: React.MouseEvent<HTMLElement>) => {
            // Prevent navigation on double-click, let the double-click handler work
            if (e.detail === 2 && navigationPath) {
                e.preventDefault();
            }
            handleClick(e as any);
        };

        const handleLinkDragStart = (e: React.DragEvent<HTMLAnchorElement>) => {
            // Prevent default browser link drag behavior to allow custom drag and drop
            e.preventDefault();
            e.stopPropagation();
        };

        return (
            <div
                className={clsx(styles.container, styles.compact, {
                    [styles.dragging]: isDragging,
                    [styles.selected]: isSelected,
                })}
                ref={ref}
            >
                <CompactItemCardImageArea
                    controls={controls}
                    data={data}
                    enableExpansion={enableExpansion}
                    enableNavigation={enableNavigation}
                    handleContextMenu={handleContextMenu}
                    handleImageClick={handleImageClick}
                    handleLinkDragStart={handleLinkDragStart}
                    imageAsLink={imageAsLink}
                    imageFetchPriority={imageFetchPriority}
                    internalState={internalState}
                    isRound={isRound}
                    itemType={itemType}
                    navigationPath={navigationPath}
                    rows={rows}
                    showRating={showRating}
                    showRatingBadge={showRatingBadge}
                    withControls={withControls}
                />
            </div>
        );
    }

    return (
        <div className={clsx(styles.container, styles.compact)}>
            <div className={clsx(styles.imageContainer, { [styles.isRound]: isRound })}>
                <Skeleton className={styles.image} />
                <div className={clsx(styles.detailContainer, styles.compact)}>
                    {rows
                        .filter(
                            (row): row is NonNullable<typeof row> =>
                                row !== null && row !== undefined,
                        )
                        .map((row, index) => (
                            <Text
                                className={clsx(styles.row, {
                                    [styles.muted]: index > 0,
                                })}
                                key={row.id}
                                size={index > 0 ? 'sm' : 'md'}
                            >
                                &nbsp;
                            </Text>
                        ))}
                </div>
            </div>
        </div>
    );
};

const DefaultItemCard = ({
    controls,
    data,
    enableExpansion,
    enableNavigation,
    imageAsLink,
    imageFetchPriority,
    internalState,
    isRound,
    itemType,
    rows,
    showRating,
    showRatingBadge,
    withControls,
}: ItemCardDerivativeProps) => {
    const itemRowId =
        data && internalState && typeof data === 'object' && 'id' in data
            ? internalState.extractRowId(data)
            : undefined;
    const isSelected = useItemSelectionState(internalState, itemRowId || undefined);

    const handleClick = useDoubleClick({
        onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
            if (!data || !controls || !internalState) {
                return;
            }

            controls.onDoubleClick?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        },
        onSingleClick: (e: React.MouseEvent<HTMLDivElement>) => {
            if (!data || !controls || !internalState) {
                return;
            }

            // Don't trigger selection if clicking on interactive elements
            const target = e.target as HTMLElement;
            const isInteractiveElement = target.closest(
                'button, a, input, select, textarea, [role="button"]',
            );

            if (isInteractiveElement) {
                return;
            }

            controls.onClick?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        },
    });

    if (data) {
        const navigationPath = getItemNavigationPath(data, itemType);

        const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
            if (!data || !controls) {
                return;
            }

            e.preventDefault();

            controls.onMore?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        };

        const handleImageClick = (e: React.MouseEvent<HTMLElement>) => {
            // Prevent navigation on double-click, let the double-click handler work
            if (e.detail === 2 && navigationPath) {
                e.preventDefault();
            }
            handleClick(e as any);
        };

        const handleLinkDragStart = (e: React.DragEvent<HTMLAnchorElement>) => {
            // Prevent default browser link drag behavior to allow custom drag and drop
            e.preventDefault();
            e.stopPropagation();
        };

        return (
            <div
                className={clsx(styles.container, {
                    [styles.selected]: isSelected,
                })}
            >
                <ItemCardStandardImageArea
                    controls={controls}
                    data={data}
                    enableExpansion={enableExpansion}
                    enableNavigation={enableNavigation}
                    handleContextMenu={handleContextMenu}
                    handleImageClick={handleImageClick}
                    handleLinkDragStart={handleLinkDragStart}
                    imageAsLink={imageAsLink}
                    imageFetchPriority={imageFetchPriority}
                    internalState={internalState}
                    isRound={isRound}
                    itemType={itemType}
                    navigationPath={navigationPath}
                    showRating={showRating}
                    showRatingBadge={showRatingBadge}
                    variant="default"
                    withControls={withControls}
                />
                <div className={styles.detailContainer}>
                    {rows
                        .filter(
                            (row): row is NonNullable<typeof row> =>
                                row !== null && row !== undefined,
                        )
                        .map((row, index) => (
                            <ItemCardRow
                                data={data!}
                                index={index}
                                key={row.id}
                                row={row}
                                type="default"
                            />
                        ))}
                </div>
            </div>
        );
    }

    return (
        <div className={clsx(styles.container)}>
            <div className={clsx(styles.imageContainer, { [styles.isRound]: isRound })}>
                <Skeleton className={styles.image} />
            </div>
            <div className={styles.detailContainer}>
                {rows
                    .filter(
                        (row): row is NonNullable<typeof row> => row !== null && row !== undefined,
                    )
                    .map((row, index) => (
                        <Text
                            className={clsx(styles.row, {
                                [styles.muted]: index > 0,
                            })}
                            key={row.id}
                            size={index > 0 ? 'sm' : 'md'}
                        >
                            &nbsp;
                        </Text>
                    ))}
            </div>
        </div>
    );
};

const PosterItemCard = ({
    controls,
    data,
    enableDrag,
    enableExpansion,
    enableMultiSelect,
    enableNavigation,
    imageAsLink,
    imageFetchPriority,
    internalState,
    isRound,
    itemType,
    rows,
    showRating,
    showRatingBadge,
    withControls,
}: ItemCardDerivativeProps) => {
    const itemRowId =
        data && internalState && typeof data === 'object' && 'id' in data
            ? internalState.extractRowId(data)
            : undefined;
    const isSelected = useItemSelectionState(internalState, itemRowId || undefined);

    const getId = useCallback(() => {
        if (!data) {
            return [];
        }

        const draggedItems = getDraggedItems(data, internalState, enableMultiSelect !== false);
        return draggedItems.map((item) => item.id);
    }, [data, internalState, enableMultiSelect]);

    const getItem = useCallback(() => {
        if (!data) {
            return [];
        }

        const draggedItems = getDraggedItems(data, internalState, enableMultiSelect !== false);
        return draggedItems;
    }, [data, internalState, enableMultiSelect]);

    const onDragStart = useCallback(() => {
        if (!data) {
            return;
        }

        const draggedItems = getDraggedItems(data, internalState, enableMultiSelect !== false);
        if (internalState) {
            internalState.setDragging(draggedItems);
        }
    }, [data, internalState, enableMultiSelect]);

    const onDrop = useCallback(() => {
        if (internalState) {
            internalState.setDragging([]);
        }
    }, [internalState]);

    const dragOperation = useMemo(
        () =>
            itemType === LibraryItem.QUEUE_SONG
                ? [DragOperation.REORDER, DragOperation.ADD]
                : [DragOperation.ADD],
        [itemType],
    );

    const drag = useMemo(
        () => ({
            getId,
            getItem,
            itemType,
            onDragStart,
            onDrop,
            operation: dragOperation,
            target: DragTarget.ALBUM,
        }),
        [getId, getItem, itemType, onDragStart, onDrop, dragOperation],
    );

    const { isDragging: isDraggingLocal, ref } = useDragDrop<HTMLDivElement>({
        drag,
        isEnabled: !!enableDrag && !!data,
    });

    const itemId = data && internalState ? data.id : undefined;
    const isDraggingState = useItemDraggingState(internalState, itemId);
    const isDragging = isDraggingState || isDraggingLocal;

    const handleClick = useDoubleClick({
        onDoubleClick: (e: React.MouseEvent<HTMLDivElement>) => {
            if (!data || !controls || !internalState) {
                return;
            }

            controls.onDoubleClick?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        },
        onSingleClick: (e: React.MouseEvent<HTMLDivElement>) => {
            if (!data || !controls || !internalState) {
                return;
            }

            // Don't trigger selection if clicking on interactive elements
            const target = e.target as HTMLElement;
            const isInteractiveElement = target.closest(
                'button, a, input, select, textarea, [role="button"]',
            );

            if (isInteractiveElement) {
                return;
            }

            controls.onClick?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        },
    });

    if (data) {
        const navigationPath = getItemNavigationPath(data, itemType);

        const handleContextMenu = (e: React.MouseEvent<HTMLElement>) => {
            if (!data || !controls) {
                return;
            }

            e.preventDefault();

            controls.onMore?.({
                event: e,
                internalState,
                item: data as any,
                itemType,
            });
        };

        const handleImageClick = (e: React.MouseEvent<HTMLElement>) => {
            // Prevent navigation on double-click, let the double-click handler work
            if (e.detail === 2 && navigationPath) {
                e.preventDefault();
            }
            handleClick(e as any);
        };

        const handleLinkDragStart = (e: React.DragEvent<HTMLAnchorElement>) => {
            // Prevent default browser link drag behavior to allow custom drag and drop
            e.preventDefault();
            e.stopPropagation();
        };

        return (
            <div
                className={clsx(styles.container, styles.poster, {
                    [styles.dragging]: isDragging,
                    [styles.selected]: isSelected,
                })}
                ref={ref}
            >
                <ItemCardStandardImageArea
                    controls={controls}
                    data={data}
                    enableExpansion={enableExpansion}
                    enableNavigation={enableNavigation}
                    handleContextMenu={handleContextMenu}
                    handleImageClick={handleImageClick}
                    handleLinkDragStart={handleLinkDragStart}
                    imageAsLink={imageAsLink}
                    imageFetchPriority={imageFetchPriority}
                    internalState={internalState}
                    isRound={isRound}
                    itemType={itemType}
                    navigationPath={navigationPath}
                    showRating={showRating}
                    showRatingBadge={showRatingBadge}
                    variant="poster"
                    withControls={withControls}
                />
                {data && (
                    <div className={styles.detailContainer}>
                        {rows
                            .filter(
                                (row): row is NonNullable<typeof row> =>
                                    row !== null && row !== undefined,
                            )
                            .map((row, index) => (
                                <ItemCardRow
                                    data={data}
                                    index={index}
                                    key={row.id}
                                    row={row}
                                    type="poster"
                                />
                            ))}
                    </div>
                )}
            </div>
        );
    }

    return (
        <div className={clsx(styles.container, styles.poster)}>
            <div className={clsx(styles.imageContainer, { [styles.isRound]: isRound })}>
                <Skeleton className={clsx(styles.image, { [styles.isRound]: isRound })} />
            </div>
            <div className={styles.detailContainer}>
                {rows
                    .filter(
                        (row): row is NonNullable<typeof row> => row !== null && row !== undefined,
                    )
                    .map((row, index) => (
                        <Text
                            className={clsx(styles.row, {
                                [styles.muted]: index > 0,
                            })}
                            key={row.id}
                            size={index > 0 ? 'sm' : 'md'}
                        >
                            &nbsp;
                        </Text>
                    ))}
            </div>
        </div>
    );
};

const MemoizedPosterItemCard = memo(PosterItemCard);
MemoizedPosterItemCard.displayName = 'MemoizedPosterItemCard';

const MemoizedCompactItemCard = memo(CompactItemCard);
MemoizedCompactItemCard.displayName = 'MemoizedCompactItemCard';

const MemoizedDefaultItemCard = memo(DefaultItemCard);
MemoizedDefaultItemCard.displayName = 'MemoizedDefaultItemCard';

const folderNameFromSongPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length < 2) return null;
    return segments[segments.length - 2] ?? null;
};

const SongAlbumName = ({ song }: { song: Song }) => {
    const useFs = useShowFilesystemNameForAlbums();
    const fsName = useFs ? folderNameFromSongPath(song.path) : null;
    const display = fsName || song.album || '';
    if (song.albumId) {
        const albumData = {
            id: song.albumId,
            imageUrl: song.imageUrl,
            name: display,
        };
        return (
            <Link
                state={{ item: albumData }}
                to={generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, {
                    albumId: song.albumId,
                })}
            >
                {display}
            </Link>
        );
    }
    return <>{display}</>;
};

const filesystemNameFromAlbumPath = (path: string): string => {
    const segments = path.split(/[/\\]/).filter(Boolean);
    return segments[segments.length - 1] || '';
};

const preloadAlbumDetail = () => preloadRoute(AppRoute.LIBRARY_ALBUMS_DETAIL);
const preloadAlbumArtistDetail = () => preloadRoute(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL);
const preloadGenreDetail = () => preloadRoute(AppRoute.LIBRARY_GENRES_DETAIL);
const preloadPlaylistDetail = () => preloadRoute(AppRoute.PLAYLISTS_DETAIL_SONGS);

const AlbumCardName = ({ data }: { data: Album }) => {
    const useFs = useShowFilesystemNameForAlbums();
    const displayName =
        useFs && data.path ? filesystemNameFromAlbumPath(data.path) || data.name : data.name;
    return (
        <Link
            onFocus={preloadAlbumDetail}
            onMouseEnter={preloadAlbumDetail}
            // Fire data prefetch the moment the user commits to a click, not
            // on hover — hovers across a long album list would otherwise spawn
            // dozens of speculative requests.
            onPointerDown={() => prefetchAlbumDetail(data.id)}
            state={{ item: data }}
            to={generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: data.id })}
        >
            <ExplicitIndicator explicitStatus={data.explicitStatus} />
            {displayName}
        </Link>
    );
};

export const getDataRows = (type?: 'compact' | 'default' | 'poster'): DataRow[] => {
    return [
        {
            format: (data) => {
                const explicitStatus = 'explicitStatus' in data ? data.explicitStatus : null;
                if ('name' in data && data.name) {
                    if ('id' in data && data.id) {
                        if ('_itemType' in data) {
                            switch (data._itemType) {
                                case LibraryItem.ALBUM:
                                    return <AlbumCardName data={data as Album} />;
                                case LibraryItem.ALBUM_ARTIST:
                                    return (
                                        <Link
                                            onFocus={preloadAlbumArtistDetail}
                                            onMouseEnter={preloadAlbumArtistDetail}
                                            state={{ item: data }}
                                            to={generatePath(
                                                AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL,
                                                {
                                                    albumArtistId: data.id,
                                                },
                                            )}
                                        >
                                            <ExplicitIndicator explicitStatus={explicitStatus} />
                                            {data.name}
                                        </Link>
                                    );
                                case LibraryItem.GENRE:
                                    return (
                                        <Link
                                            onFocus={preloadGenreDetail}
                                            onMouseEnter={preloadGenreDetail}
                                            state={{ item: data }}
                                            to={generatePath(AppRoute.LIBRARY_GENRES_DETAIL, {
                                                genreId: data.id,
                                            })}
                                        >
                                            {data.name}
                                        </Link>
                                    );
                                case LibraryItem.PLAYLIST:
                                    return (
                                        <Link
                                            onFocus={preloadPlaylistDetail}
                                            onMouseEnter={preloadPlaylistDetail}
                                            state={{ item: data }}
                                            to={generatePath(AppRoute.PLAYLISTS_DETAIL_SONGS, {
                                                playlistId: data.id,
                                            })}
                                        >
                                            {data.name}
                                        </Link>
                                    );
                                default:
                                    return (
                                        <>
                                            <ExplicitIndicator explicitStatus={explicitStatus} />
                                            {data.name}
                                        </>
                                    );
                            }
                        }
                    }
                    return (
                        <>
                            <ExplicitIndicator explicitStatus={explicitStatus} />
                            {data.name}
                        </>
                    );
                }
                return '';
            },
            id: 'name',
        },
        {
            format: (data) => {
                if ('albumArtists' in data && Array.isArray(data.albumArtists)) {
                    return (
                        <JoinedArtists
                            artistName={data.albumArtistName}
                            artists={data.albumArtists}
                            linkProps={{ fw: 400, isMuted: true }}
                            // Card subtitles are one line — a 50-artist
                            // compilation must not render a wall of names.
                            maxArtists={4}
                            rootTextProps={{
                                fw: 400,
                                isMuted: type === 'compact' ? false : true,
                                size: 'sm',
                            }}
                        />
                    );
                }
                return '';
            },
            id: 'albumArtists',
            isMuted: true,
        },
        {
            format: (data) => {
                if ('artists' in data && Array.isArray(data.artists)) {
                    // Card subtitles are one line — cap big compilations the
                    // same way the albumArtists row does.
                    const all = (data as Album | Song).artists;
                    const visible = all.slice(0, 4);
                    return (
                        <>
                            {visible.map((artist, index) => (
                                <Fragment key={artist.id}>
                                    <Link
                                        onFocus={preloadAlbumArtistDetail}
                                        onMouseEnter={preloadAlbumArtistDetail}
                                        state={{ item: artist }}
                                        to={generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
                                            albumArtistId: artist.id,
                                        })}
                                    >
                                        {artist.name}
                                    </Link>
                                    {index < visible.length - 1 && <Separator />}
                                </Fragment>
                            ))}
                            {all.length > visible.length && ` +${all.length - visible.length}`}
                        </>
                    );
                }
                return '';
            },
            id: 'artists',
            isMuted: true,
        },
        {
            format: (data) => {
                if ('duration' in data && data.duration !== null) {
                    return formatDurationString(data.duration);
                }
                return '';
            },
            id: 'duration',
        },
        {
            format: (data) => {
                if ('releaseYear' in data && data.releaseYear != null) {
                    const releaseYear = data.releaseYear;
                    const originalYear =
                        'originalYear' in data && data.originalYear > 0 ? data.originalYear : null;

                    if (originalYear !== null && originalYear !== releaseYear) {
                        return `${originalYear}${SEPARATOR_STRING}${releaseYear}`;
                    }

                    return String(releaseYear);
                }
                return '';
            },
            id: 'releaseYear',
        },
        {
            format: (data) => {
                if ('releaseDate' in data && data.releaseDate) {
                    if (
                        'originalDate' in data &&
                        data.originalDate &&
                        data.originalDate !== data.releaseDate
                    ) {
                        return `${formatPartialIsoDateUTC(data.originalDate)}${SEPARATOR_STRING}${formatPartialIsoDateUTC(data.releaseDate)}`;
                    }

                    return `${formatPartialIsoDateUTC(data.releaseDate)}`;
                }
                return '';
            },
            id: 'releaseDate',
        },
        {
            format: (data) => {
                if ('createdAt' in data && data.createdAt) {
                    return formatDateAbsolute(data.createdAt);
                }
                return '';
            },
            id: 'createdAt',
        },
        {
            format: (data) => {
                if ('lastPlayedAt' in data && data.lastPlayedAt) {
                    return (
                        <Group align="center" gap="xs">
                            <Icon icon="lastPlayed" size="sm" />
                            {formatDateRelative(data.lastPlayedAt)}
                        </Group>
                    );
                }
                return '';
            },
            id: 'lastPlayedAt',
        },
        {
            format: (data) => {
                if ('playCount' in data && data.playCount !== null) {
                    return i18n.t('entity.play', { count: data.playCount });
                }
                return '';
            },
            id: 'playCount',
        },
        {
            format: (data) => {
                if ('genres' in data && Array.isArray(data.genres)) {
                    return (data as Album | AlbumArtist | Song).genres
                        .map((genre) => genre.name)
                        .join(', ');
                }
                return '';
            },
            id: 'genres',
            isMuted: true,
        },
        {
            format: (data) => {
                if ('album' in data && data.album) {
                    return <SongAlbumName song={data as Song} />;
                }
                return '';
            },
            id: 'album',
            isMuted: true,
        },
        {
            format: (data) => {
                if ('songCount' in data && data.songCount !== null) {
                    return i18n.t('entity.trackWithCount', { count: data.songCount });
                }
                return '';
            },
            id: 'songCount',
        },
        {
            format: (data) => {
                if ('albumCount' in data && data.albumCount !== null) {
                    return i18n.t('entity.albumWithCount', { count: data.albumCount });
                }
                return '';
            },
            id: 'albumCount',
        },
        {
            format: (data) => {
                if (
                    'userRating' in data &&
                    (data as Album | AlbumArtist | Song).userRating !== null
                ) {
                    return formatRating(data as Album | AlbumArtist | Song);
                }
                return null;
            },
            id: 'rating',
        },
        {
            format: (data) => {
                if ('userFavorite' in data) {
                    return (data as Album | AlbumArtist | Song).userFavorite ? '★' : '';
                }
                return '';
            },
            id: 'userFavorite',
        },
    ];
};

export const getDataRowsCount = () => {
    return getDataRows().length;
};

const getImageUrl = (data: Album | AlbumArtist | Artist | Genre | Playlist | Song | undefined) => {
    if (data && 'imageUrl' in data) {
        return data.imageUrl || undefined;
    }

    return undefined;
};

const GenreImagePlaceholder = ({ className, name }: { className?: string; name: string }) => {
    const { color, isLight } = useMemo(() => stringToColor(name), [name]);
    return (
        <div
            className={className}
            style={{
                backgroundColor: color,
                color: isLight ? '#000' : '#fff',
            }}
        >
            <span className={styles.genrePlaceholderText}>{name}</span>
        </div>
    );
};

const getItemNavigationPath = (
    data: Album | AlbumArtist | Artist | Genre | Playlist | Song | undefined,
    itemType: LibraryItem,
): null | string => {
    if (!data || !('id' in data) || !data.id) {
        return null;
    }

    const effectiveItemType = '_itemType' in data && data._itemType ? data._itemType : itemType;

    return getTitlePath(effectiveItemType, data.id);
};

/**
 * Touch tap fallback for cards that are NOT a navigation <Link> — i.e. cards
 * with no detail route (songs) where the cover would otherwise be inert on
 * touch.
 *
 * On the Home "Most Played" / "Recently played" shelves a Jellyfin server
 * renders SONG item-cards. Songs have no navigationPath (getTitlePath returns
 * null for LibraryItem.SONG), so isLinkBranch is false and the cover renders
 * as a plain <div>. Its only click handler is handleImageClick →
 * useDoubleClick → controls.onClick/onDoubleClick, both of which early-return
 * when the card has no internalState — and these carousels pass none. The
 * long-press hook's onPress also no-oped for non-link cards. Net result:
 * tapping a song cover did nothing (device, 2026-06-11).
 *
 * Mirrors the desktop hover play-button path: prefer the list-aware
 * onDoubleClick when an internalState is present, otherwise fall back to the
 * single-item onPlay (Play.NOW), which needs only the item. Returns true when
 * an action was dispatched so the caller can suppress the trailing
 * synthesised click.
 */
const triggerCardTapPlay = (
    controls: ItemControls | undefined,
    data: ItemCardData,
    itemType: LibraryItem,
    internalState?: ItemListStateActions,
): boolean => {
    if (!controls || !data || !('id' in data) || !data.id) {
        return false;
    }

    const effectiveItemType =
        '_itemType' in data && (data as { _itemType?: LibraryItem })._itemType
            ? (data as { _itemType: LibraryItem })._itemType
            : itemType;

    const isSongItem =
        effectiveItemType === LibraryItem.SONG || effectiveItemType === LibraryItem.PLAYLIST_SONG;

    // Only songs have a meaningful "tap the cover to play" action. Non-song
    // non-link cards (should not normally occur) stay inert here.
    if (!isSongItem) {
        return false;
    }

    if (controls.onDoubleClick && internalState) {
        const rowId = internalState.extractRowId(data);
        if (rowId) {
            const index = internalState.findItemIndex(rowId);
            controls.onDoubleClick({
                event: null,
                index,
                internalState,
                item: data,
                itemType: effectiveItemType,
                meta: { playType: Play.NOW },
            });
            return true;
        }
    }

    if (controls.onPlay) {
        controls.onPlay({
            event: null,
            internalState,
            item: data,
            itemType: effectiveItemType,
            playType: Play.NOW,
        });
        return true;
    }

    return false;
};

const ItemCardRow = memo(
    ({
        data,
        index,
        row,
        type,
    }: {
        data: Album | AlbumArtist | Artist | Genre | Playlist | Song | undefined;
        index: number;
        row: DataRow;
        type?: 'compact' | 'default' | 'poster';
    }) => {
        const alignmentClass =
            row.align === 'center'
                ? styles['align-center']
                : row.align === 'end'
                  ? styles['align-end']
                  : styles['align-start'];

        // All rows except the first one (index 0) should be muted
        const isMuted = index > 0 || row.isMuted;

        const formattedContent = useMemo(() => {
            if (!data) {
                return null;
            }
            return row.format(data);
        }, [data, row]);

        if (!data) {
            return (
                <div
                    className={clsx(styles.row, alignmentClass, {
                        [styles.compact]: type === 'compact',
                        [styles.default]: type === 'default',
                        [styles.muted]: isMuted,
                        [styles.poster]: type === 'poster',
                    })}
                >
                    &nbsp;
                </div>
            );
        }

        return (
            <Text
                className={clsx(styles.row, alignmentClass, {
                    [styles.bold]: index === 0,
                    [styles.compact]: type === 'compact',
                    [styles.default]: type === 'default',
                    [styles.muted]: isMuted,
                    [styles.poster]: type === 'poster',
                })}
                size={index > 0 ? 'sm' : 'md'}
            >
                {formattedContent}
            </Text>
        );
    },
);

ItemCardRow.displayName = 'ItemCardRow';

export const MemoizedItemCard = memo(ItemCard);
