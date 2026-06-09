import { MouseEvent, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './quick-picks.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { useAlbumInfiniteListSuspenseQuery } from '/@/renderer/features/albums/queries/albums-queries';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useSongListInfinite } from '/@/renderer/features/songs/components/song-infinite-carousel';
import { prefetchAlbumDetail } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer, useCurrentServerId, usePlayButtonBehavior } from '/@/renderer/store';
import { Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { Text } from '/@/shared/components/text/text';
import {
    AlbumListResponse,
    AlbumListSort,
    LibraryItem,
    ServerType,
    SongListResponse,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

const QUICK_PICK_LIMIT = 8;

// Must match the recently-played carousels in `home-route.tsx` exactly so
// both surfaces resolve to the same React Query cache entry and only one
// network request goes out. Jellyfin tracks play recency on SONGS (album
// recency is unreliable there), so on Jellyfin we share the song shelf's
// stream and fold the songs into their albums; everywhere else we share the
// album shelf's stream directly.
const RECENTLY_PLAYED_ALBUM_QUERY_KEY = ['home', 'album', 'recentlyPlayed'] as const;
const RECENTLY_PLAYED_SONG_QUERY_KEY = ['home', 'song', 'recentlyPlayed'] as const;
const RECENTLY_PLAYED_PAGE_SIZE = 20;

interface QuickPickItem {
    id: string;
    imageId?: null | string;
    imageUrl?: null | string;
    name: string;
    // Full entity for the router location state, when the source stream has
    // one (album detail seeds its first paint from it).
    routeState?: unknown;
}

/**
 * Spotify-style "quick picks" zone: a responsive grid of short, wide tiles
 * (album cover + title) for the most-recently-played albums. This is the
 * Home top-zone Spotify shows above the shelves — the highest-relevance
 * one-tap re-entry points.
 *
 * Data: shares the matching recently-played shelf's infinite query (same
 * query key + page size) so the two surfaces dedupe to a single request and
 * share cache/snapshot/offline behaviour. The suspending read is wrapped
 * locally so the parent doesn't need its own boundary; the skeleton renders
 * while the shared query resolves.
 *
 * Each tile is a `Link` to the album detail; a hover/focus-revealed play
 * button enqueues the album via the player's `addToQueueByFetch` (pointer
 * devices only — on touch the button is hidden so the title keeps the
 * space, and the tap target is the tile itself). A truly empty history
 * collapses the whole zone.
 */
const QuickPickTiles = ({ items }: { items: QuickPickItem[] }) => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();
    const playButtonBehavior = usePlayButtonBehavior();
    const { addToQueueByFetch } = usePlayer();

    const handlePlay = useCallback(
        (event: MouseEvent, albumId: string) => {
            event.preventDefault();
            event.stopPropagation();
            if (!serverId) return;
            addToQueueByFetch(serverId, [albumId], LibraryItem.ALBUM, playButtonBehavior);
        },
        [addToQueueByFetch, playButtonBehavior, serverId],
    );

    if (items.length === 0) {
        return null;
    }

    return (
        <div className={styles.grid}>
            {items.map((item) => (
                <Link
                    className={styles.tile}
                    key={item.id}
                    onMouseEnter={() => prefetchAlbumDetail(item.id)}
                    onPointerDown={() => prefetchAlbumDetail(item.id)}
                    state={item.routeState ? { item: item.routeState } : undefined}
                    to={generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: item.id })}
                >
                    <div className={styles.tileImage}>
                        <ItemImage
                            id={item.imageId}
                            itemType={LibraryItem.ALBUM}
                            src={item.imageUrl ?? undefined}
                            type="itemCard"
                        />
                    </div>
                    <Text className={styles.tileTitle} isNoSelect overflow="hidden">
                        {item.name}
                    </Text>
                    <button
                        aria-label={t('player.play', { defaultValue: 'Play' })}
                        className={styles.playButton}
                        onClick={(event) => handlePlay(event, item.id)}
                        type="button"
                    >
                        <Icon icon="mediaPlay" size="lg" />
                    </button>
                </Link>
            ))}
        </div>
    );
};

const QuickPicksAlbums = () => {
    const serverId = useCurrentServerId();

    const { data } = useAlbumInfiniteListSuspenseQuery({
        itemLimit: RECENTLY_PLAYED_PAGE_SIZE,
        query: {
            sortBy: AlbumListSort.RECENTLY_PLAYED,
            sortOrder: SortOrder.DESC,
        },
        queryKey: RECENTLY_PLAYED_ALBUM_QUERY_KEY,
        serverId,
    });

    const allAlbums = data?.pages.flatMap((page: AlbumListResponse) => page.items) ?? [];
    const items: QuickPickItem[] = allAlbums.slice(0, QUICK_PICK_LIMIT).map((album) => ({
        id: album.id,
        imageId: album.imageId,
        imageUrl: album.imageUrl,
        name: album.name,
        routeState: album,
    }));

    return <QuickPickTiles items={items} />;
};

/**
 * Jellyfin variant: play recency lives on songs there (the album-level
 * RECENTLY_PLAYED sort returns effectively arbitrary albums), so fold the
 * recently-played SONG stream — shared with the song shelf below — into the
 * unique albums those songs belong to, in first-played order.
 */
const QuickPicksJellyfinSongs = () => {
    const { data } = useSongListInfinite(
        SongListSort.RECENTLY_PLAYED,
        SortOrder.DESC,
        RECENTLY_PLAYED_PAGE_SIZE,
        undefined,
        RECENTLY_PLAYED_SONG_QUERY_KEY,
    );

    const songs = data?.pages.flatMap((page: SongListResponse) => page.items) ?? [];
    const seen = new Set<string>();
    const items: QuickPickItem[] = [];
    for (const song of songs) {
        if (!song.albumId || seen.has(song.albumId)) continue;
        seen.add(song.albumId);
        items.push({
            id: song.albumId,
            imageId: song.imageId,
            imageUrl: song.imageUrl,
            name: song.album ?? song.name,
        });
        if (items.length >= QUICK_PICK_LIMIT) break;
    }

    return <QuickPickTiles items={items} />;
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
    const server = useCurrentServer();
    const isJellyfin = server?.type === ServerType.JELLYFIN;

    return (
        <Suspense fallback={<QuickPicksSkeleton />}>
            {isJellyfin ? <QuickPicksJellyfinSongs /> : <QuickPicksAlbums />}
        </Suspense>
    );
};
