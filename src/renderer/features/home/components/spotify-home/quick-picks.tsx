import { MouseEvent, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './quick-picks.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { useAlbumListQuery } from '/@/renderer/features/albums/queries/albums-queries';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { prefetchAlbumDetail } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Text } from '/@/shared/components/text/text';
import { Album, AlbumListSort, LibraryItem, SortOrder } from '/@/shared/types/domain-types';

const QUICK_PICK_LIMIT = 8;

/**
 * Spotify-style "quick picks" zone: a responsive grid of short, wide tiles
 * (album cover + title) for the most-recently-played albums. This is the
 * Home top-zone Spotify shows above the shelves — the highest-relevance
 * one-tap re-entry points.
 *
 * Data: the existing `useAlbumListQuery` with `RECENTLY_PLAYED` desc. Reusing
 * the shared query means these tiles share the same cache, snapshot, and
 * offline behaviour as the rest of the app — no bespoke API call.
 *
 * Each tile is a `Link` to the album detail; a hover/focus-revealed play
 * button enqueues the album via the player's `addToQueueByFetch`. The tile
 * renders nothing while loading-empty (the parent shows a skeleton); a truly
 * empty history collapses the whole zone (handled by the parent).
 */
export const QuickPicks = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const playButtonBehavior = usePlayButtonBehavior();
    const { addToQueueByFetch } = usePlayer();

    const { data, isLoading } = useAlbumListQuery({
        query: {
            limit: QUICK_PICK_LIMIT,
            sortBy: AlbumListSort.RECENTLY_PLAYED,
            sortOrder: SortOrder.DESC,
            startIndex: 0,
        },
        serverId,
    });

    const albums = data?.items ?? [];

    const handlePlay = useCallback(
        (event: MouseEvent, album: Album) => {
            event.preventDefault();
            event.stopPropagation();
            if (!serverId) return;
            addToQueueByFetch(serverId, [album.id], LibraryItem.ALBUM, playButtonBehavior);
        },
        [addToQueueByFetch, playButtonBehavior, serverId],
    );

    if (isLoading) {
        return (
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
    }

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
