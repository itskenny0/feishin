import { useMemo } from 'react';

import styles from './entity-shelf.module.css';

import { MemoizedItemCard } from '/@/renderer/components/item-card/item-card';
import { useDefaultItemListControls } from '/@/renderer/components/item-list/helpers/item-list-controls';
import { useGridRows } from '/@/renderer/components/item-list/helpers/use-grid-rows';
import { ShelfTitle } from '/@/renderer/features/home/components/spotify-home/shelf-title';
import { AppRoute } from '/@/renderer/router/routes';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { AlbumArtist, LibraryItem, Playlist } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface EntityShelfProps {
    isLoading?: boolean;
    /** Circular covers (artists) vs rounded squares (playlists). */
    isRound?: boolean;
    itemListKey: ItemListKey;
    items: Array<AlbumArtist | Playlist>;
    itemType: LibraryItem;
    showAllRoute?: AppRoute;
    title: string;
}

const SKELETON_COUNT = 8;

/**
 * Horizontal-scroll shelf for entity types the album-only carousel can't
 * render — album-artists (circular covers) and playlists (rounded squares).
 *
 * Reuses the shared `MemoizedItemCard` (so cover art, hover controls, drag,
 * context menu, and navigation all match the rest of the app) inside a
 * native horizontal scroller. On touch this is a natural swipe; on desktop
 * shift+wheel scrolls horizontally via the browser default. Cards are a
 * fixed CSS width so the row reads as a Spotify shelf rather than a wrapping
 * grid, and the whole shelf collapses to nothing when there are no items.
 */
export const EntityShelf = ({
    isLoading,
    isRound,
    itemListKey,
    items,
    itemType,
    showAllRoute,
    title,
}: EntityShelfProps) => {
    const controls = useDefaultItemListControls();
    const rows = useGridRows(itemType, itemListKey);

    const cards = useMemo(
        () =>
            items.map((item) => (
                <div className={styles.card} key={item.id}>
                    <MemoizedItemCard
                        controls={controls}
                        data={item}
                        enableDrag
                        imageFetchPriority="low"
                        isRound={isRound}
                        itemType={itemType}
                        rows={rows}
                        type="poster"
                        withControls
                    />
                </div>
            )),
        [controls, isRound, items, itemType, rows],
    );

    if (!isLoading && items.length === 0) {
        return null;
    }

    return (
        <section className={styles.shelf}>
            <div className={styles.header}>
                <ShelfTitle showAllRoute={showAllRoute} title={title} />
            </div>
            <div className={styles.scroller}>
                {isLoading
                    ? Array.from({ length: SKELETON_COUNT }).map((_, index) => (
                          <div className={styles.card} key={index}>
                              <Skeleton
                                  borderRadius={isRound ? '50%' : 'var(--theme-radius-sm)'}
                                  className={styles.cardSkeleton}
                                  enableAnimation
                              />
                          </div>
                      ))
                    : cards}
            </div>
        </section>
    );
};
