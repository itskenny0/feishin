import { MouseEvent, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './quick-picks.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { useAlbumInfiniteListSuspenseQuery } from '/@/renderer/features/albums/queries/albums-queries';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { prefetchAlbumDetail } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Text } from '/@/shared/components/text/text';
import {
    Album,
    AlbumListResponse,
    AlbumListSort,
    LibraryItem,
    SortOrder,
} from '/@/shared/types/domain-types';

const QUICK_PICK_LIMIT = 8;

// Must match the recently-played album carousel in `home-route.tsx` exactly so
// both surfaces resolve to the same React Query cache entry and only one
// network request goes out. The carousel mounts
// `useAlbumInfiniteListSuspenseQuery` with this same key + page size; sharing
// the key means QuickPicks slices the first N items off that one cached stream
// instead of issuing its own `RECENTLY_PLAYED` list request.
const RECENTLY_PLAYED_QUERY_KEY = ['home', 'album', 'recentlyPlayed'] as const;
const RECENTLY_PLAYED_PAGE_SIZE = 20;

/**
 * Spotify-style "quick picks" zone: a responsive grid of short, wide tiles
 * (album cover + title) for the most-recently-played albums. This is the
 * Home top-zone Spotify shows above the shelves — the highest-relevance
 * one-tap re-entry points.
 *
 * Data: shares the recently-played album carousel's infinite query (same query
 * key + page size) and slices the first {@link QUICK_PICK_LIMIT} items, so the
 * two surfaces dedupe to a single request and share cache/snapshot/offline
 * behaviour. The suspending read is wrapped locally so the parent doesn't need
 * its own boundary; the skeleton renders while the shared query resolves.
 *
 * Each tile is a `Link` to the album detail; a hover/focus-revealed play
 * button enqueues the album via the player's `addToQueueByFetch`. A truly
 * empty history collapses the whole zone.
 */
const QuickPicksGrid = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const playButtonBehavior = usePlayButtonBehavior();
    const { addToQueueByFetch } = usePlayer();

    const { data } = useAlbumInfiniteListSuspenseQuery({
        itemLimit: RECENTLY_PLAYED_PAGE_SIZE,
        query: {
            sortBy: AlbumListSort.RECENTLY_PLAYED,
            sortOrder: SortOrder.DESC,
        },
        queryKey: RECENTLY_PLAYED_QUERY_KEY,
        serverId,
    });

    const allAlbums = data?.pages.flatMap((page: AlbumListResponse) => page.items) ?? [];
    const albums = allAlbums.slice(0, QUICK_PICK_LIMIT);

    const handlePlay = useCallback(
        (event: MouseEvent, album: Album) => {
            event.preventDefault();
            event.stopPropagation();
            if (!serverId) return;
            addToQueueByFetch(serverId, [album.id], LibraryItem.ALBUM, playButtonBehavior);
        },
        [addToQueueByFetch, playButtonBehavior, serverId],
    );

    if (albums.length === 0) {
        return null;
    }

    return (
        <div className={styles.grid}>
            {albums.map((album) => (
                <Link
                    className={styles.tile}
                    key={album.id}
                    onMouseEnter={() => prefetchAlbumDetail(album.id)}
                    onPointerDown={() => prefetchAlbumDetail(album.id)}
                    state={{ item: album }}
                    to={generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: album.id })}
                >
                    <div className={styles.tileImage}>
                        <ItemImage
                            id={album.imageId}
                            itemType={LibraryItem.ALBUM}
                            src={album.imageUrl}
                            type="itemCard"
                        />
                    </div>
                    <Text className={styles.tileTitle} isNoSelect overflow="hidden">
                        {album.name}
                    </Text>
                    <button
                        aria-label={t('player.play', { defaultValue: 'Play' })}
                        className={styles.playButton}
                        onClick={(event) => handlePlay(event, album)}
                        type="button"
                    >
                        <Icon icon="mediaPlay" size="lg" />
                    </button>
                </Link>
            ))}
        </div>
    );
};

const QuickPicksSkeleton = () => (
    <div className={styles.grid}>
        {Array.from({ length: QUICK_PICK_LIMIT }).map((_, index) => (
            <Skeleton
                borderRadius="var(--theme-radius-sm)"
                className={styles.tileSkeleton}
                enableAnimation
                key={index}
            />
        ))}
    </div>
);

export const QuickPicks = () => {
    return (
        <Suspense fallback={<QuickPicksSkeleton />}>
            <QuickPicksGrid />
        </Suspense>
    );
};
