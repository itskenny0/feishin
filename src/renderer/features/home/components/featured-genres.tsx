import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './featured-genres.module.css';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    cachedSwr,
    isCacheAvailableSync,
    readSnapshot,
    snapshotSwr,
    toCachedAlbumRow,
} from '/@/renderer/cache';
import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useFuzzyGenreIds } from '/@/renderer/features/genres/api/genres-api';
import { useGenreListSuspenseQuery } from '/@/renderer/features/genres/queries/genres-queries';
import { isCleanGenreName } from '/@/renderer/features/home/utils/genre-filter';
import { useIsPlayerFetching, usePlayer } from '/@/renderer/features/player/context/player-context';
import { PlayButton } from '/@/renderer/features/shared/components/play-button';
import { useContainerQuery } from '/@/renderer/hooks';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer, useCurrentServerId } from '/@/renderer/store';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import {
    Album,
    AlbumListSort,
    Genre,
    GenreListSort,
    LibraryItem,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';
import { stringToColor } from '/@/shared/utils/string-to-color';

// Largest tile count any breakpoint renders. We only ever need this many
// usable genres, so the fetch and the sample are both bounded to a small
// multiple of it instead of pulling/shuffling the entire genre table.
const MAX_VISIBLE_GENRES = 18;
// Fetch a bounded slice rather than the whole genre table (`limit: -1`). A few
// hundred is far more than the <=18 tiles we show, and large enough that the
// random sample stays varied across home visits even on big libraries.
const GENRE_FETCH_LIMIT = 300;
// Sample headroom so the clean-name filter can drop a few candidates and we
// still have MAX_VISIBLE_GENRES usable tiles.
const GENRE_SAMPLE_SIZE = MAX_VISIBLE_GENRES * 2;

function getGenresToShow(breakpoints: {
    isLargerThanLg: boolean;
    isLargerThanMd: boolean;
    isLargerThanSm: boolean;
    isLargerThanXl: boolean;
    isLargerThanXxl: boolean;
    isLargerThanXxxl: boolean;
}) {
    if (breakpoints.isLargerThanXxxl) {
        return 18;
    }

    if (breakpoints.isLargerThanXxl) {
        return 15;
    }

    if (breakpoints.isLargerThanXl) {
        return 12;
    }

    if (breakpoints.isLargerThanLg) {
        return 12;
    }

    if (breakpoints.isLargerThanMd) {
        return 12;
    }

    if (breakpoints.isLargerThanSm) {
        return 8;
    }

    return 6;
}

/**
 * Randomly samples up to `count` items from `items` using a partial
 * Fisher-Yates shuffle — only `count` swaps, so the work is O(count), not
 * O(items.length). Avoids `lodash.shuffle`'s full-array shuffle (which copied
 * and shuffled every genre just to show a handful of tiles).
 */
function sampleN<T>(items: readonly T[], count: number): T[] {
    const n = items.length;
    if (n === 0 || count <= 0) return [];
    const take = Math.min(count, n);
    // Shallow copy so we never mutate the source (React Query data). The copy
    // is bounded by GENRE_FETCH_LIMIT upstream, so this stays cheap.
    const pool = items.slice();
    const out: T[] = [];
    for (let i = 0; i < take; i += 1) {
        const j = i + Math.floor(Math.random() * (n - i));
        const picked = pool[j];
        pool[j] = pool[i];
        pool[i] = picked;
        out.push(picked);
    }
    return out;
}

export const FeaturedGenres = () => {
    const { t } = useTranslation();
    const server = useCurrentServer();
    const { ref, ...cq } = useContainerQuery({
        lg: 900,
        md: 600,
        sm: 360,
    });

    const genresQuery = useGenreListSuspenseQuery({
        query: {
            limit: GENRE_FETCH_LIMIT,
            sortBy: GenreListSort.NAME,
            sortOrder: SortOrder.ASC,
            startIndex: 0,
        },
        queryKey: [server.id, 'home', 'featured-genres'],
        serverId: server?.id,
    });

    const randomGenres = useMemo(() => {
        if (!genresQuery.data?.items) return [];
        // Drop garbage names before sampling so the visible-N slice is
        // guaranteed to be N usable tiles, not N candidates we then filter
        // down to (which produced fewer-than-expected tiles). Sample a small
        // bounded set instead of shuffling the entire (capped) genre list.
        const clean = genresQuery.data.items.filter((g: Genre) => isCleanGenreName(g.name));
        return sampleN(clean, GENRE_SAMPLE_SIZE);
    }, [genresQuery.data]);

    const genresToShow = useMemo(() => {
        return getGenresToShow({
            isLargerThanLg: cq.isLg,
            isLargerThanMd: cq.isMd,
            isLargerThanSm: cq.isSm,
            isLargerThanXl: cq.isXl,
            isLargerThanXxl: cq.is2xl,
            isLargerThanXxxl: cq.is3xl,
        });
    }, [cq.isLg, cq.isMd, cq.isSm, cq.isXl, cq.is2xl, cq.is3xl]);

    const visibleGenres = useMemo(() => {
        return randomGenres.slice(0, genresToShow);
    }, [randomGenres, genresToShow]);

    const genresWithColors = useMemo(() => {
        if (!visibleGenres) return [];

        return visibleGenres.map((genre: Genre) => {
            const { color, isLight } = stringToColor(genre.name);
            const path = generatePath(AppRoute.LIBRARY_GENRES_DETAIL, { genreId: genre.id });

            return {
                ...genre,
                color,
                isLight,
                path,
            };
        });
    }, [visibleGenres]);

    return (
        <div className={styles.container} ref={ref}>
            {cq.isCalculated && (
                <>
                    <Group align="flex-end" justify="space-between">
                        <TextTitle fw={700} isNoSelect order={3}>
                            {t('entity.genre', { count: 2 })}
                        </TextTitle>
                        <Button
                            component={Link}
                            size="compact-sm"
                            to={AppRoute.LIBRARY_GENRES}
                            variant="subtle"
                        >
                            {t('action.viewMore')}
                        </Button>
                    </Group>
                    <div className={styles.grid}>
                        {genresWithColors.map((genre) => (
                            <GenreItem genre={genre} key={genre.id} />
                        ))}
                    </div>
                </>
            )}
        </div>
    );
};

/**
 * Fetch one album that carries this genre so the tile can show its cover
 * as a backdrop. Cached aggressively — covers don't change and re-fetching
 * on every home visit wasted requests.
 */
const useGenreCoverAlbum = (genreId: string, serverId: string, enabled: boolean) =>
    useQuery({
        enabled: enabled && Boolean(genreId && serverId),
        gcTime: 1000 * 60 * 60 * 24,
        placeholderData: (() =>
            readSnapshot<Album | null>(['featured-genre-cover', serverId, genreId])) as never,
        queryFn: (ctx) => {
            const key = ['featured-genre-cover', serverId, genreId] as const;
            return cachedSwr<Album | null>({
                apply: async (db, fresh) => {
                    if (fresh) await db.albums.put(toCachedAlbumRow(fresh));
                },
                ctx,
                // Serve any cached album with this genre tag so the tile
                // renders cover art offline after a sync has run.
                // Uses the *GenreIds multi-entry index (v7) for an O(log n)
                // indexed lookup instead of a full db.albums.toArray() scan.
                fromCache: async (db) => {
                    if (!isCacheAvailableSync()) return undefined;
                    const row = await db.albums.where('GenreIds').equals(genreId).first();
                    return row ? row.Payload : undefined;
                },
                queryKey: key,
                remote: async ({ signal }) => {
                    const res = await api.controller.getAlbumList({
                        apiClientProps: { serverId, signal },
                        query: {
                            genreIds: [genreId],
                            limit: 1,
                            sortBy: AlbumListSort.RANDOM,
                            sortOrder: SortOrder.DESC,
                            startIndex: 0,
                        },
                    });
                    return res?.items?.[0] ?? null;
                },
            });
        },
        queryKey: ['featured-genre-cover', serverId, genreId] as const,
        // 24h — covers are functionally static and re-fetching costs an
        // entire album-list request per tile.
        staleTime: 1000 * 60 * 60 * 24,
    });

const GenrePlayButton = ({ genre }: { genre: Genre }) => {
    const queryClient = useQueryClient();
    const isPlayerFetching = useIsPlayerFetching();
    const player = usePlayer();
    const serverId = useCurrentServerId();
    // Expand to every genre whose name contains the clicked one so 'metal'
    // also plays 'death metal', 'black metal', etc. Falls back to the
    // single id when no matches.
    const fuzzyIds = useFuzzyGenreIds(genre.id);

    const handlePlay = useCallback(async () => {
        if (!serverId) return;

        // getSongList accepts genreIds (plural array); getRandomSongList
        // only takes a single genre string, which would defeat the fuzzy
        // expansion. Sort RANDOM + a generous limit gives a comparable
        // shuffled set. Wrap in try/catch so an offline tap doesn't throw
        // out of the click handler — the queue just stays put.
        try {
            const data = await queryClient.fetchQuery({
                gcTime: 0,
                queryFn: (ctx) =>
                    snapshotSwr({
                        ctx,
                        queryKey: queryKeys.player.fetch(),
                        remote: ({ signal }) =>
                            api.controller.getSongList({
                                apiClientProps: { serverId, signal },
                                query: {
                                    genreIds: fuzzyIds,
                                    limit: 100,
                                    sortBy: SongListSort.RANDOM,
                                    sortOrder: SortOrder.DESC,
                                    startIndex: 0,
                                },
                            }),
                    }),
                queryKey: queryKeys.player.fetch(),
                staleTime: 0,
            });

            player.addToQueueByData(data?.items || [], Play.NOW);
        } catch (err) {
            console.warn('[featured-genres] play failed', err);
        }
    }, [player, queryClient, serverId, fuzzyIds]);

    return (
        <span className={styles.playButtonWrapper}>
            <PlayButton fill={true} isSecondary loading={isPlayerFetching} onClick={handlePlay} />
        </span>
    );
};

const GenreItem = memo(({ genre }: { genre: Genre & { color: string; path: string } }) => {
    const serverId = useCurrentServerId() ?? '';
    const containerRef = useRef<HTMLDivElement>(null);
    // Defer the per-tile cover request until the tile scrolls near the
    // viewport. The genres grid is the bottom-most home shelf and usually
    // offscreen at first paint, so firing one album-list request per tile on
    // mount competed with the (visible) shelf queries for no visible benefit.
    // Once visible we latch on — the cover is cached for 24h and never needs
    // re-gating, so this only ever gates the initial burst.
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (isVisible) return;
        const el = containerRef.current;
        if (!el) return;

        if (typeof IntersectionObserver === 'undefined') {
            // Safe fallback for environments without IO (older webviews,
            // tests): just enable the query.
            setIsVisible(true);
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    setIsVisible(true);
                    observer.disconnect();
                }
            },
            // Pre-load a little before the tile is actually on screen so the
            // cover is ready by the time the user scrolls to it.
            { rootMargin: '200px' },
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [isVisible]);

    const { data: coverAlbum } = useGenreCoverAlbum(genre.id, serverId, isVisible);
    const coverImageUrl = useCachedItemImageUrl({
        id: coverAlbum?.imageId || undefined,
        imageUrl: coverAlbum?.imageUrl || undefined,
        itemType: LibraryItem.ALBUM,
        serverId,
        type: 'itemCard',
    });

    return (
        <div
            className={styles.genreContainer}
            key={genre.id}
            ref={containerRef}
            style={
                {
                    '--genre-color': genre.color,
                } as React.CSSProperties
            }
        >
            {coverImageUrl && (
                <div
                    aria-hidden
                    className={styles.genreBackdrop}
                    style={{ backgroundImage: `url(${coverImageUrl})` }}
                />
            )}
            <div aria-hidden className={styles.genreScrim} />
            <Link className={styles.genreLink} state={{ item: genre }} to={genre.path}>
                <span className={styles.genreName}>{genre.name}</span>
                <GenrePlayButton genre={genre} />
            </Link>
        </div>
    );
});

GenreItem.displayName = 'GenreItem';
