import { useQuery, useQueryClient } from '@tanstack/react-query';
import { shuffle } from 'lodash';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './featured-genres.module.css';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import { readSnapshot, writeSnapshot } from '/@/renderer/cache';
import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
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
            limit: -1,
            sortBy: GenreListSort.NAME,
            sortOrder: SortOrder.ASC,
            startIndex: 0,
        },
        queryKey: [server.id, 'home', 'featured-genres'],
        serverId: server?.id,
    });

    const randomGenres = useMemo(() => {
        if (!genresQuery.data?.items) return [];
        // Drop garbage names before shuffling so the visible-N slice is
        // guaranteed to be N usable tiles, not N candidates we then filter
        // down to (which produced fewer-than-expected tiles).
        const clean = genresQuery.data.items.filter((g: Genre) => isCleanGenreName(g.name));
        return shuffle(clean);
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
const useGenreCoverAlbum = (genreId: string, serverId: string) =>
    useQuery({
        enabled: Boolean(genreId && serverId),
        gcTime: 1000 * 60 * 60 * 24,
        placeholderData: (() =>
            readSnapshot<Album | null>(['featured-genre-cover', serverId, genreId])) as never,
        queryFn: async ({ signal }) => {
            const key = ['featured-genre-cover', serverId, genreId] as const;
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
            const result = res?.items?.[0] ?? null;
            writeSnapshot(key, result);
            return result;
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
        // shuffled set.
        const data = await queryClient.fetchQuery({
            gcTime: 0,
            queryFn: () => {
                return api.controller.getSongList({
                    apiClientProps: { serverId },
                    query: {
                        genreIds: fuzzyIds,
                        limit: 100,
                        sortBy: SongListSort.RANDOM,
                        sortOrder: SortOrder.DESC,
                        startIndex: 0,
                    },
                });
            },
            queryKey: queryKeys.player.fetch(),
            staleTime: 0,
        });

        player.addToQueueByData(data?.items || [], Play.NOW);
    }, [player, queryClient, serverId, fuzzyIds]);

    return (
        <span className={styles.playButtonWrapper}>
            <PlayButton fill={true} isSecondary loading={isPlayerFetching} onClick={handlePlay} />
        </span>
    );
};

const GenreItem = memo(({ genre }: { genre: Genre & { color: string; path: string } }) => {
    const serverId = useCurrentServerId() ?? '';
    const { data: coverAlbum } = useGenreCoverAlbum(genre.id, serverId);
    const coverImageUrl = useItemImageUrl({
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
