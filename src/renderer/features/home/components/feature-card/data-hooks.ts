import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TFunction } from 'i18next';
import { useEffect, useMemo, useRef } from 'react';
import { generatePath } from 'react-router';

import { api } from '/@/renderer/api';
import {
    FeatureCardData,
    SONGS_PER_CARD,
} from '/@/renderer/features/home/components/feature-card/feature-card-shell';
import { usePoolRotation } from '/@/renderer/features/home/components/feature-card/use-pool-rotation';
import { AppRoute } from '/@/renderer/router/routes';
import {
    AlbumArtist,
    AlbumArtistListSort,
    Genre,
    GenreListSort,
    Played,
    Song,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

// ============================================================================
// Common constants
// ============================================================================

/**
 * Collapse duplicate songs (same track tagged on a single, album, and a
 * compilation = three rows in Jellyfin) down to one. Libraries with heavy
 * duplication were filling the 10-tile grid with the same track 3-4 times.
 * We also use this list for "Play all", so dedupe at this layer fixes both
 * the visible grid and the enqueue.
 */
const dedupeSongsByTitle = (songs: Song[]): Song[] => {
    const seen = new Set<string>();
    const out: Song[] = [];
    for (const song of songs) {
        // MusicBrainz recording ID is the most reliable cross-release
        // identity when it exists; fall back to a normalized title so two
        // slightly-different taggings of "Stronger" still collapse.
        const key =
            song.mbzRecordingId ||
            song.mbzTrackId ||
            (song.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
        if (!key) {
            // Don't dedupe rows with no usable key — they could legitimately
            // be different songs that just happen to be untagged.
            out.push(song);
            continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(song);
    }
    return out;
};

const MIN_SONG_COUNT = 30;
const FALLBACK_MIN_SONG_COUNT = 10;
// Hard floor — single-song artists are never useful for a "featured artist"
// grid. Better to surface an explicit empty state than to dress up a
// one-track-wonder as if it were a curated pick.
const HARD_MIN_SONG_COUNT = 5;
const CANDIDATE_FETCH_LIMIT = 200;
const YEAR_POOL_RANGE: [number, number] = [1960, new Date().getFullYear()];

// ============================================================================
// Featured Artist
// ============================================================================

interface ArtistCandidate {
    id: string;
    name: string;
    songCount: null | number;
}

const useArtistCandidates = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        gcTime: 1000 * 60 * 60,
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as ArtistCandidate[];
            const res = await api.controller.getAlbumArtistList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: CANDIDATE_FETCH_LIMIT,
                    sortBy: AlbumArtistListSort.RANDOM,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            const all: ArtistCandidate[] = (res?.items ?? []).map((a: AlbumArtist) => ({
                id: a.id,
                name: a.name,
                songCount: a.songCount ?? null,
            }));
            // Cascade through progressively more permissive thresholds, but
            // never below the hard floor — the user reported single-song
            // artists slipping through when the unfiltered `all` was returned.
            const primary = all.filter((a) => (a.songCount ?? 0) >= MIN_SONG_COUNT);
            if (primary.length >= 3) return primary;
            const fallback = all.filter((a) => (a.songCount ?? 0) >= FALLBACK_MIN_SONG_COUNT);
            if (fallback.length >= 3) return fallback;
            const lastResort = all.filter((a) => (a.songCount ?? 0) >= HARD_MIN_SONG_COUNT);
            // Even if this leaves us with 0 or 1 candidates, surface that —
            // the variant's empty-state copy handles "no artist found".
            return lastResort;
        },
        queryKey: ['feature-card-artists', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 60,
    });

const useArtistSongs = (artistId: null | string, serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(artistId && serverId),
        gcTime: 1000 * 60 * 30,
        // Keep the previous artist's songs visible while the next set fetches.
        // Without this, every rotation tick blanks the grid to skeletons for
        // a beat, which the user perceives as the card "flashing".
        placeholderData: keepPreviousData,
        queryFn: async ({ signal }) => {
            if (!artistId || !serverId) return [] as Song[];
            // Over-fetch so dedupeSongsByTitle still produces a full grid for
            // libraries where the same track is tagged on a single + album +
            // compilation. 3× is enough for typical duplication levels.
            const res = await api.controller.getSongList({
                apiClientProps: { serverId, signal },
                query: {
                    albumArtistIds: [artistId],
                    limit: SONGS_PER_CARD * 3,
                    sortBy: SongListSort.RANDOM,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-artist-songs', serverId ?? '', artistId ?? ''] as const,
        staleTime: 1000 * 60 * 5,
    });

export const useArtistFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const { data: candidates, isLoading } = useArtistCandidates(serverId);
    const pool = candidates ?? [];
    const { goNext, goPrev, index, reshuffle } = usePoolRotation(pool.length);
    const current = pool[index % Math.max(pool.length, 1)] as ArtistCandidate | undefined;
    const { data: songs, isFetching } = useArtistSongs(current?.id ?? null, serverId);
    const empty = !isLoading && pool.length === 0;

    return {
        eyebrow: t('page.home.featureArtist_eyebrow'),
        isLoading: isLoading || (Boolean(current) && isFetching && (songs ?? []).length === 0),
        onNext: pool.length > 1 ? goNext : undefined,
        onPrev: pool.length > 1 ? goPrev : undefined,
        onReshuffle: reshuffle,
        rotationCount: pool.length,
        rotationIndex: index,
        songs: songs ?? [],
        subtitle: empty
            ? t('page.home.featureVariant_empty_subtitle')
            : current?.songCount
              ? t('page.home.featureArtist_trackCount', { count: current.songCount })
              : t('page.home.featureArtist_trackCount_unknown'),
        title: empty ? t('page.home.featureVariant_empty_title') : (current?.name ?? '…'),
        titleHref: current
            ? generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, { albumArtistId: current.id })
            : undefined,
    };
};

// ============================================================================
// Featured Genre
// ============================================================================

interface GenreCandidate {
    albumCount: null | number;
    id: string;
    name: string;
    songCount: null | number;
}

const useGenreCandidates = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        gcTime: 1000 * 60 * 60,
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as GenreCandidate[];
            const res = await api.controller.getGenreList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: CANDIDATE_FETCH_LIMIT,
                    sortBy: GenreListSort.NAME,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
            });
            return (res?.items ?? []).map((g: Genre) => ({
                albumCount: g.albumCount ?? null,
                id: g.id,
                name: g.name,
                songCount: g.songCount ?? null,
            }));
        },
        queryKey: ['feature-card-genres', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 60,
    });

const useGenreSongs = (
    genreId: null | string,
    serverType: string | undefined,
    genreName: string,
    serverId: string | undefined,
) =>
    useQuery({
        enabled: Boolean(genreId && serverId),
        gcTime: 1000 * 60 * 30,
        placeholderData: keepPreviousData,
        queryFn: async ({ signal }) => {
            if (!genreId || !serverId) return [] as Song[];
            // Jellyfin uses genre id; navidrome/subsonic use genre name. Pass the
            // form that matches the server (mirrors the shuffle-all modal logic).
            const genreParam = serverType === 'jellyfin' ? genreId : genreName;
            const res = await api.controller.getRandomSongList({
                apiClientProps: { serverId, signal },
                query: { genre: genreParam, limit: SONGS_PER_CARD * 3, played: Played.All },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-genre-songs', serverId ?? '', genreId ?? ''] as const,
        staleTime: 1000 * 60 * 5,
    });

export const useGenreFeatureData = (
    serverId: string | undefined,
    serverType: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const { data: candidates, isLoading } = useGenreCandidates(serverId);
    const pool = useMemo(
        () => (candidates ?? []).filter((g) => (g.albumCount ?? 0) > 0),
        [candidates],
    );
    const { goNext, goPrev, index, reshuffle } = usePoolRotation(pool.length);
    const current = pool[index % Math.max(pool.length, 1)] as GenreCandidate | undefined;
    const { data: songs, isFetching } = useGenreSongs(
        current?.id ?? null,
        serverType,
        current?.name ?? '',
        serverId,
    );
    const empty = !isLoading && pool.length === 0;

    return {
        eyebrow: t('page.home.featureGenre_eyebrow'),
        isLoading: isLoading || (Boolean(current) && isFetching && (songs ?? []).length === 0),
        onNext: pool.length > 1 ? goNext : undefined,
        onPrev: pool.length > 1 ? goPrev : undefined,
        onReshuffle: reshuffle,
        rotationCount: pool.length,
        rotationIndex: index,
        songs: songs ?? [],
        subtitle: empty
            ? t('page.home.featureVariant_empty_subtitle')
            : current?.albumCount
              ? t('page.home.featureGenre_albumCount', { count: current.albumCount })
              : undefined,
        title: empty ? t('page.home.featureVariant_empty_title') : (current?.name ?? '…'),
        titleHref: current
            ? generatePath(AppRoute.LIBRARY_GENRES_DETAIL, { genreId: current.id })
            : undefined,
    };
};

// ============================================================================
// Recently Played
// ============================================================================

const useRecentlyPlayedSongs = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as Song[];
            const res = await api.controller.getSongList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: SONGS_PER_CARD * 3,
                    sortBy: SongListSort.RECENTLY_PLAYED,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-recently-played', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 2,
    });

export const useRecentlyPlayedFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const { data: songs, isLoading, refetch } = useRecentlyPlayedSongs(serverId);
    return {
        eyebrow: t('page.home.featureRecentlyPlayed_eyebrow'),
        isLoading,
        onReshuffle: () => void refetch(),
        songs: songs ?? [],
        subtitle: t('page.home.featureRecentlyPlayed_subtitle'),
        title: t('page.home.featureRecentlyPlayed_title'),
    };
};

// ============================================================================
// Top Played
// ============================================================================

const useTopPlayedSongs = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as Song[];
            const res = await api.controller.getSongList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: SONGS_PER_CARD * 3,
                    sortBy: SongListSort.PLAY_COUNT,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-top-played', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 10,
    });

export const useTopPlayedFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const { data: songs, isLoading, refetch } = useTopPlayedSongs(serverId);
    return {
        eyebrow: t('page.home.featureTopPlayed_eyebrow'),
        isLoading,
        onReshuffle: () => void refetch(),
        songs: songs ?? [],
        subtitle: t('page.home.featureTopPlayed_subtitle'),
        title: t('page.home.featureTopPlayed_title'),
    };
};

// ============================================================================
// Favorites Mix
// ============================================================================

const useFavoritesSongs = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as Song[];
            const res = await api.controller.getSongList({
                apiClientProps: { serverId, signal },
                query: {
                    favorite: true,
                    limit: SONGS_PER_CARD * 3,
                    sortBy: SongListSort.RANDOM,
                    sortOrder: SortOrder.DESC,
                    startIndex: 0,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        // staleTime 0 so reshuffle truly re-randomises rather than serving cached
        queryKey: ['feature-card-favorites', serverId ?? ''] as const,
        staleTime: 0,
    });

export const useFavoritesFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const { data: songs, isLoading, refetch } = useFavoritesSongs(serverId);
    return {
        eyebrow: t('page.home.featureFavorites_eyebrow'),
        isLoading,
        onReshuffle: () => void refetch(),
        songs: songs ?? [],
        subtitle: t('page.home.featureFavorites_subtitle'),
        title: t('page.home.featureFavorites_title'),
    };
};

// ============================================================================
// Unplayed Discoveries
// ============================================================================

const useUnplayedSongs = (serverId: string | undefined, reseedCounter: number) =>
    useQuery({
        enabled: Boolean(serverId),
        placeholderData: keepPreviousData,
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as Song[];
            const res = await api.controller.getRandomSongList({
                apiClientProps: { serverId, signal },
                query: { limit: SONGS_PER_CARD * 3, played: Played.Never },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        // The reseed counter is part of the queryKey so reshuffle gets a fresh
        // server-side random sample instead of the cached set.
        queryKey: ['feature-card-unplayed', serverId ?? '', reseedCounter] as const,
        staleTime: 0,
    });

export const useUnplayedFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    // Use the rotation index as a reseed nonce; pool size of 100 is arbitrary —
    // we never have 100 different samples but each reshuffle just increments.
    const { index, reshuffle } = usePoolRotation(100);
    const { data: songs, isLoading } = useUnplayedSongs(serverId, index);
    return {
        eyebrow: t('page.home.featureUnplayed_eyebrow'),
        isLoading,
        onReshuffle: reshuffle,
        songs: songs ?? [],
        subtitle: t('page.home.featureUnplayed_subtitle'),
        title: t('page.home.featureUnplayed_title'),
    };
};

// ============================================================================
// Forgotten Favorites
// ============================================================================

const useForgottenFavoritesSongs = (serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(serverId),
        queryFn: async ({ signal }) => {
            if (!serverId) return [] as Song[];
            // Favorites sorted by least-recently-played first. Result is
            // approximate: "favorites you haven't touched in a while" without
            // needing an absolute date filter.
            const res = await api.controller.getSongList({
                apiClientProps: { serverId, signal },
                query: {
                    favorite: true,
                    limit: SONGS_PER_CARD * 3,
                    sortBy: SongListSort.RECENTLY_PLAYED,
                    sortOrder: SortOrder.ASC,
                    startIndex: 0,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-forgotten', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 30,
    });

export const useForgottenFavoritesFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const { data: songs, isLoading, refetch } = useForgottenFavoritesSongs(serverId);
    return {
        eyebrow: t('page.home.featureForgotten_eyebrow'),
        isLoading,
        onReshuffle: () => void refetch(),
        songs: songs ?? [],
        subtitle: t('page.home.featureForgotten_subtitle'),
        title: t('page.home.featureForgotten_title'),
    };
};

// ============================================================================
// Time Machine — single year
// ============================================================================

const useTimeMachineSongs = (year: null | number, serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(year && serverId),
        placeholderData: keepPreviousData,
        queryFn: async ({ signal }) => {
            if (!year || !serverId) return [] as Song[];
            const res = await api.controller.getRandomSongList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: SONGS_PER_CARD * 3,
                    maxYear: year,
                    minYear: year,
                    played: Played.All,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-time-machine', serverId ?? '', year ?? 0] as const,
        staleTime: 1000 * 60 * 5,
    });

// Year pool is wide (~66 years) and most libraries cluster heavily in a few
// recent decades. Six retries hit a populated year ~62% of the time; thirty
// retries push that past 99% on even the sparsest libraries while still being
// O(retries) in network calls, not O(years).
const MAX_AUTO_SKIP_RETRIES = 30;

export const useTimeMachineFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const [minYear, maxYear] = YEAR_POOL_RANGE;
    const yearPool = useMemo(() => {
        const arr: number[] = [];
        for (let y = minYear; y <= maxYear; y += 1) arr.push(y);
        return arr;
    }, [minYear, maxYear]);

    const { goNext, goPrev, index, reshuffle } = usePoolRotation(yearPool.length);
    const year = yearPool[index % yearPool.length];
    const { data: songs, isFetching, isLoading } = useTimeMachineSongs(year, serverId);

    // The picked year may have zero tracks in this user's library. Auto-skip
    // up to N times to a different year so the user doesn't have to hammer
    // reshuffle to find a populated era. After N attempts we give up and
    // show the empty state so the cycle doesn't burn requests forever on
    // libraries with very few year tags.
    const retryCountRef = useRef(0);
    useEffect(() => {
        if (isFetching || isLoading) return;
        if (!songs) return;
        if (songs.length > 0) {
            retryCountRef.current = 0;
            return;
        }
        if (retryCountRef.current < MAX_AUTO_SKIP_RETRIES) {
            retryCountRef.current += 1;
            reshuffle();
        }
    }, [isFetching, isLoading, reshuffle, songs]);

    const empty = !isLoading && !isFetching && (songs?.length ?? 0) === 0;

    return {
        eyebrow: t('page.home.featureTimeMachine_eyebrow'),
        isLoading,
        onNext: yearPool.length > 1 ? goNext : undefined,
        onPrev: yearPool.length > 1 ? goPrev : undefined,
        onReshuffle: () => {
            retryCountRef.current = 0;
            reshuffle();
        },
        rotationCount: yearPool.length,
        rotationIndex: index,
        songs: songs ?? [],
        subtitle: empty ? t('page.home.featureTimeMachine_empty') : undefined,
        title: String(year),
    };
};

// ============================================================================
// Decade Dive
// ============================================================================

const useDecadeSongs = (decadeStart: null | number, serverId: string | undefined) =>
    useQuery({
        enabled: Boolean(decadeStart !== null && serverId),
        placeholderData: keepPreviousData,
        queryFn: async ({ signal }) => {
            if (decadeStart === null || !serverId) return [] as Song[];
            const res = await api.controller.getRandomSongList({
                apiClientProps: { serverId, signal },
                query: {
                    limit: SONGS_PER_CARD * 3,
                    maxYear: decadeStart + 9,
                    minYear: decadeStart,
                    played: Played.All,
                },
            });
            return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, SONGS_PER_CARD);
        },
        queryKey: ['feature-card-decade', serverId ?? '', decadeStart ?? -1] as const,
        staleTime: 1000 * 60 * 5,
    });

export const useDecadeDiveFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const [minYear, maxYear] = YEAR_POOL_RANGE;
    const decades = useMemo(() => {
        const arr: number[] = [];
        const firstDecade = Math.floor(minYear / 10) * 10;
        for (let d = firstDecade; d <= maxYear; d += 10) arr.push(d);
        return arr;
    }, [minYear, maxYear]);

    const { goNext, goPrev, index, reshuffle } = usePoolRotation(decades.length);
    const decade = decades[index % decades.length];
    const { data: songs, isFetching, isLoading } = useDecadeSongs(decade, serverId);

    // Same auto-skip pattern as time machine: decades with no tracks are
    // skipped without making the user click reshuffle. Lower retry budget
    // because there are only ~7 decades.
    const retryCountRef = useRef(0);
    useEffect(() => {
        if (isFetching || isLoading || !songs) return;
        if (songs.length > 0) {
            retryCountRef.current = 0;
            return;
        }
        if (retryCountRef.current < 4) {
            retryCountRef.current += 1;
            reshuffle();
        }
    }, [isFetching, isLoading, reshuffle, songs]);

    const empty = !isLoading && !isFetching && (songs?.length ?? 0) === 0;

    return {
        eyebrow: t('page.home.featureDecade_eyebrow'),
        isLoading,
        onNext: decades.length > 1 ? goNext : undefined,
        onPrev: decades.length > 1 ? goPrev : undefined,
        onReshuffle: () => {
            retryCountRef.current = 0;
            reshuffle();
        },
        rotationCount: decades.length,
        rotationIndex: index,
        songs: songs ?? [],
        subtitle: empty
            ? t('page.home.featureTimeMachine_empty')
            : t('page.home.featureDecade_subtitle'),
        title: `${decade}s`,
    };
};
