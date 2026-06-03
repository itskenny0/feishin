import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generatePath } from 'react-router';

import { api } from '/@/renderer/api';
import {
    cachedSwr,
    getActiveCacheDb,
    isCacheAvailableSync,
    readSnapshot,
    snapshotSwr,
    toCachedSongRow,
} from '/@/renderer/cache';
import { FeatureCardData } from '/@/renderer/features/home/components/feature-card/feature-card-shell';
import { usePoolRotation } from '/@/renderer/features/home/components/feature-card/use-pool-rotation';
import { isCleanGenreName } from '/@/renderer/features/home/utils/genre-filter';
import { AppRoute } from '/@/renderer/router/routes';
import { useHomeFeatureCardSongsPerCard } from '/@/renderer/store/settings.store';
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
 *
 * Important: the title-only fallback is SCOPED PER ARTIST. Without this,
 * across a mixed-artist grid (favorites, top-played, recently-played), a
 * song called "Intro" by Artist A and a totally different "Intro" by
 * Artist B would collide and one would silently drop out — a real concern
 * for libraries heavy on Monstercat / electronic compilations where
 * generic titles ("Intro", "Outro", "Sunshine", "Stay") are common.
 */
const dedupeSongsByTitle = (songs: Song[]): Song[] => {
    const seen = new Set<string>();
    const out: Song[] = [];
    for (const song of songs) {
        // MusicBrainz recording ID is the most reliable cross-release
        // identity when it exists; fall back to a normalized title +
        // artist so two slightly-different taggings of "Stronger" by the
        // same artist still collapse, but "Stronger" by two different
        // artists don't.
        const title = (song.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const artist = (song.artistName || song.albumArtistName || '')
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');
        const key = song.mbzRecordingId || song.mbzTrackId || (title ? `${artist}::${title}` : '');
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

const CANDIDATE_FETCH_LIMIT = 200;
const YEAR_POOL_RANGE: [number, number] = [1960, new Date().getFullYear()];

// Best-effort Dexie write-through for feature-card fetches. The home page
// rotates random song/album/artist pools every 30s; each pool refresh is a
// chance to populate the cache for whatever the user clicks into next.
const writeSongsToCache = async (songs: Song[]): Promise<void> => {
    if (!isCacheAvailableSync() || songs.length === 0) return;
    try {
        const db = getActiveCacheDb();
        if (db) await db.songs.bulkPut(songs.map(toCachedSongRow));
    } catch {
        /* swallow */
    }
};

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
        placeholderData: (() =>
            readSnapshot<ArtistCandidate[]>(['feature-card-artists-v2', serverId ?? ''])) as never,
        queryFn: (ctx) => {
            const key = ['feature-card-artists-v2', serverId ?? ''] as const;
            return cachedSwr<ArtistCandidate[]>({
                ctx,
                fromCache: async (db) => {
                    if (!isCacheAvailableSync()) return undefined;
                    const rows = await db.artists.where('Kind').equals('AlbumArtist').toArray();
                    if (rows.length === 0) return undefined;
                    const all: ArtistCandidate[] = rows.map((r) => ({
                        id: r.Payload.id,
                        name: r.Payload.name,
                        songCount: r.Payload.songCount ?? null,
                    }));
                    const usable = all.filter((a) => a.songCount === null || a.songCount >= 2);
                    return usable.length > 0 ? usable : all;
                },
                queryKey: key,
                remote: async ({ signal }) => {
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

                    // Drop only artists with a *known* songCount < 2. Null
                    // counts (server omits SongCount) pass through so we
                    // never end up with an empty pool just because the
                    // API didn't return the count.
                    const usable = all.filter((a) => a.songCount === null || a.songCount >= 2);

                    // Tiny libraries where every artist has exactly one
                    // song still get a working card rather than the empty
                    // state — better to show something.
                    return usable.length > 0 ? usable : all;
                },
            });
        },
        // v2 — invalidate any stale empty-result cache from the previous
        // tiered-filter version that some clients may have persisted.
        queryKey: ['feature-card-artists-v2', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 60,
    });

const useArtistSongs = (
    artistId: null | string,
    serverId: string | undefined,
    songsPerCard: number,
) =>
    useQuery({
        enabled: Boolean(artistId && serverId),
        gcTime: 1000 * 60 * 30,
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-artist-songs',
                serverId ?? '',
                artistId ?? '',
                songsPerCard,
            ])) as never,
        // Intentionally NO keepPreviousData here. The artist-card auto-skips
        // single-song artists by calling goNext() from a useEffect, which can
        // change the current artist several times in quick succession. With
        // placeholderData on, the title would update to the new artist while
        // the previous artist's songs lingered in the grid — visually that
        // reads as 'wrong songs for this artist'. Better to flash a brief
        // skeleton than to display inconsistent state.
        queryFn: (ctx) => {
            const key = [
                'feature-card-artist-songs',
                serverId ?? '',
                artistId ?? '',
                songsPerCard,
            ] as const;
            return cachedSwr<Song[]>({
                apply: async (_db, fresh) => {
                    await writeSongsToCache(fresh ?? []);
                },
                ctx,
                fromCache: async (db) => {
                    if (!artistId || !isCacheAvailableSync()) return undefined;
                    const rows = await db.songs.where('AlbumArtistId').equals(artistId).toArray();
                    if (rows.length === 0) return undefined;
                    const songs = dedupeSongsByTitle(rows.map((r) => r.Payload)).slice(
                        0,
                        songsPerCard,
                    );
                    return songs.length > 0 ? songs : undefined;
                },
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!artistId || !serverId) return [] as Song[];
                    // Over-fetch so dedupeSongsByTitle still produces a full
                    // grid for libraries where the same track is tagged on a
                    // single + album + compilation. 3× is enough for typical
                    // duplication levels.
                    const res = await api.controller.getSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            albumArtistIds: [artistId],
                            limit: songsPerCard * 3,
                            sortBy: SongListSort.RANDOM,
                            sortOrder: SortOrder.DESC,
                            startIndex: 0,
                        },
                    });
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: [
            'feature-card-artist-songs',
            serverId ?? '',
            artistId ?? '',
            songsPerCard,
        ] as const,
        staleTime: 1000 * 60 * 5,
    });

// Cap how often we auto-advance past a known-single-song artist before
// giving up. On a library full of single-track features this could otherwise
// loop hundreds of times. 20 is a comfortable budget — even with 90% of the
// random candidate pool being singles, the expected number of attempts to
// find an artist with ≥2 songs is ≪ 20.
const MAX_SINGLE_SONG_AUTO_SKIPS = 20;

/** Validated display state — only updated when we have an artist with ≥2 songs. */
interface ShownArtist {
    artist: ArtistCandidate;
    idx: number;
    songs: Song[];
}

export const useArtistFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { data: candidates, isLoading } = useArtistCandidates(serverId);
    const pool = candidates ?? [];
    const { goNext, goPrev, index, reshuffle } = usePoolRotation(pool.length);
    const current = pool[index % Math.max(pool.length, 1)] as ArtistCandidate | undefined;
    const { data: songs, isFetching } = useArtistSongs(current?.id ?? null, serverId, songsPerCard);

    // Two-tier state: `current` is the candidate being evaluated; `shown` is
    // the artist actually rendered to the user. The display only advances to
    // a new artist when their songs come back as ≥2 unique tracks (or we've
    // exhausted retries). Auto-skips through single-song artists happen
    // silently in the background — the user never sees the bad candidates.
    const [shown, setShown] = useState<null | ShownArtist>(null);
    const skipCountRef = useRef(0);

    // Reset `shown` and the skip counter when the server changes — without
    // this, switching servers would leave the previous server's artist on
    // screen (and its titleHref would point at a dead route on the new
    // server) until the new candidate pool settled.
    useEffect(() => {
        skipCountRef.current = 0;
        setShown(null);
    }, [serverId]);

    useEffect(() => {
        if (isFetching || isLoading || !songs || !current) return;
        const exhausted = skipCountRef.current >= MAX_SINGLE_SONG_AUTO_SKIPS;
        const canSkip = pool.length >= 2;

        if (songs.length >= 2 || exhausted || !canSkip) {
            // Settle: this is the artist we'll display. If we exhausted
            // retries on a library full of single-song artists, show the
            // current pick rather than leaving the user on a stale or empty
            // state forever.
            skipCountRef.current = 0;
            setShown({ artist: current, idx: index, songs });
            return;
        }

        // Still searching — advance silently. `shown` keeps the previous
        // valid artist visible (or stays null on first load) so the user
        // never sees the in-between candidates flash by.
        skipCountRef.current += 1;
        goNext();
    }, [songs, isFetching, isLoading, current, pool.length, index, goNext]);

    // User-initiated changes clear `shown` so the card transitions to a
    // skeleton immediately — visible feedback that something is happening
    // while we evaluate the next pick(s). The 30s auto-rotation and the
    // auto-skip itself DON'T clear `shown`; they just re-evaluate in the
    // background and update `shown` once a valid candidate is found, which
    // reads as a smooth crossfade rather than a flash.
    const handlePrev = useCallback(() => {
        skipCountRef.current = 0;
        setShown(null);
        goPrev();
    }, [goPrev]);

    const handleNext = useCallback(() => {
        skipCountRef.current = 0;
        setShown(null);
        goNext();
    }, [goNext]);

    const handleReshuffle = useCallback(() => {
        skipCountRef.current = 0;
        setShown(null);
        reshuffle();
    }, [reshuffle]);

    const empty = !isLoading && pool.length === 0;

    return {
        eyebrow: t('page.home.featureArtist_eyebrow'),
        isLoading: isLoading || (!shown && Boolean(current) && !empty),
        onNext: pool.length > 1 ? handleNext : undefined,
        onPrev: pool.length > 1 ? handlePrev : undefined,
        onReshuffle: handleReshuffle,
        rotationCount: pool.length,
        rotationIndex: shown?.idx ?? index,
        songs: shown?.songs ?? [],
        subtitle: empty
            ? t('page.home.featureVariant_empty_subtitle')
            : shown?.artist.songCount
              ? t('page.home.featureArtist_trackCount', { count: shown.artist.songCount })
              : t('page.home.featureArtist_trackCount_unknown'),
        title: empty ? t('page.home.featureVariant_empty_title') : (shown?.artist.name ?? '…'),
        titleHref: shown?.artist
            ? generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
                  albumArtistId: shown.artist.id,
              })
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
        placeholderData: (() =>
            readSnapshot<GenreCandidate[]>(['feature-card-genres', serverId ?? ''])) as never,
        queryFn: (ctx) => {
            const key = ['feature-card-genres', serverId ?? ''] as const;
            return cachedSwr<GenreCandidate[]>({
                ctx,
                fromCache: async (db) => {
                    if (!isCacheAvailableSync()) return undefined;
                    const rows = await db.genres.toArray();
                    if (rows.length === 0) return undefined;
                    return rows.map((r) => ({
                        albumCount: r.Payload.albumCount ?? null,
                        id: r.Payload.id,
                        name: r.Payload.name,
                        songCount: r.Payload.songCount ?? null,
                    }));
                },
                queryKey: key,
                remote: async ({ signal }) => {
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
            });
        },
        queryKey: ['feature-card-genres', serverId ?? ''] as const,
        staleTime: 1000 * 60 * 60,
    });

const useGenreSongs = (
    genreId: null | string,
    serverType: string | undefined,
    genreName: string,
    serverId: string | undefined,
    songsPerCard: number,
) =>
    useQuery({
        enabled: Boolean(genreId && serverId),
        gcTime: 1000 * 60 * 30,
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-genre-songs',
                serverId ?? '',
                genreId ?? '',
                songsPerCard,
            ])) as never,
        // No keepPreviousData: when the user clicks prev/next or the 30s
        // rotation fires, we want the grid to clear immediately so the
        // title and songs are never out of sync. Brief skeleton flash is
        // acceptable; lingering wrong-genre songs under a new title is not.
        queryFn: (ctx) => {
            const key = [
                'feature-card-genre-songs',
                serverId ?? '',
                genreId ?? '',
                songsPerCard,
            ] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!genreId || !serverId) return [] as Song[];
                    // Jellyfin uses genre id; navidrome/subsonic use genre
                    // name. Pass the form that matches the server (mirrors
                    // the shuffle-all modal logic).
                    const genreParam = serverType === 'jellyfin' ? genreId : genreName;
                    const res = await api.controller.getRandomSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            genre: genreParam,
                            limit: songsPerCard * 3,
                            played: Played.All,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: [
            'feature-card-genre-songs',
            serverId ?? '',
            genreId ?? '',
            songsPerCard,
        ] as const,
        staleTime: 1000 * 60 * 5,
    });

export const useGenreFeatureData = (
    serverId: string | undefined,
    serverType: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { data: candidates, isLoading } = useGenreCandidates(serverId);
    const pool = useMemo(
        // Previous filter required albumCount > 0, but Jellyfin's genre
        // normalize hardcodes albumCount: null — every candidate was rejected
        // and the card was permanently stuck on its empty state. Trust the
        // API: if Jellyfin returned the genre, it exists. Drop only names
        // that are obviously junk so we don't surface 'rap;50 Cent;...' as a
        // featured genre.
        () => (candidates ?? []).filter((g) => isCleanGenreName(g.name)),
        [candidates],
    );
    const { goNext, goPrev, index, reshuffle } = usePoolRotation(pool.length);
    const current = pool[index % Math.max(pool.length, 1)] as GenreCandidate | undefined;
    const { data: songs, isFetching } = useGenreSongs(
        current?.id ?? null,
        serverType,
        current?.name ?? '',
        serverId,
        songsPerCard,
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

const useRecentlyPlayedSongs = (serverId: string | undefined, songsPerCard: number) =>
    useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-recently-played',
                serverId ?? '',
                songsPerCard,
            ])) as never,
        queryFn: (ctx) => {
            const key = ['feature-card-recently-played', serverId ?? '', songsPerCard] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!serverId) return [] as Song[];
                    const res = await api.controller.getSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            limit: songsPerCard * 3,
                            sortBy: SongListSort.RECENTLY_PLAYED,
                            sortOrder: SortOrder.DESC,
                            startIndex: 0,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: ['feature-card-recently-played', serverId ?? '', songsPerCard] as const,
        staleTime: 1000 * 60 * 2,
    });

export const useRecentlyPlayedFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { data: songs, isLoading, refetch } = useRecentlyPlayedSongs(serverId, songsPerCard);
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

const useTopPlayedSongs = (serverId: string | undefined, songsPerCard: number) =>
    useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-top-played',
                serverId ?? '',
                songsPerCard,
            ])) as never,
        queryFn: (ctx) => {
            const key = ['feature-card-top-played', serverId ?? '', songsPerCard] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!serverId) return [] as Song[];
                    const res = await api.controller.getSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            limit: songsPerCard * 3,
                            sortBy: SongListSort.PLAY_COUNT,
                            sortOrder: SortOrder.DESC,
                            startIndex: 0,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: ['feature-card-top-played', serverId ?? '', songsPerCard] as const,
        staleTime: 1000 * 60 * 10,
    });

export const useTopPlayedFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { data: songs, isLoading, refetch } = useTopPlayedSongs(serverId, songsPerCard);
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

const useFavoritesSongs = (serverId: string | undefined, songsPerCard: number) =>
    useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-favorites',
                serverId ?? '',
                songsPerCard,
            ])) as never,
        queryFn: (ctx) => {
            const key = ['feature-card-favorites', serverId ?? '', songsPerCard] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!serverId) return [] as Song[];
                    const res = await api.controller.getSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            favorite: true,
                            limit: songsPerCard * 3,
                            sortBy: SongListSort.RANDOM,
                            sortOrder: SortOrder.DESC,
                            startIndex: 0,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        // staleTime 0 so reshuffle truly re-randomises rather than serving cached
        queryKey: ['feature-card-favorites', serverId ?? '', songsPerCard] as const,
        staleTime: 0,
    });

export const useFavoritesFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { data: songs, isLoading, refetch } = useFavoritesSongs(serverId, songsPerCard);
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

const useUnplayedSongs = (
    serverId: string | undefined,
    reseedCounter: number,
    songsPerCard: number,
) =>
    useQuery({
        enabled: Boolean(serverId),
        placeholderData: keepPreviousData,
        queryFn: (ctx) => {
            const key = [
                'feature-card-unplayed',
                serverId ?? '',
                reseedCounter,
                songsPerCard,
            ] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!serverId) return [] as Song[];
                    const res = await api.controller.getRandomSongList({
                        apiClientProps: { serverId, signal },
                        query: { limit: songsPerCard * 3, played: Played.Never },
                    });
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        // The reseed counter is part of the queryKey so reshuffle gets a fresh
        // server-side random sample instead of the cached set.
        queryKey: ['feature-card-unplayed', serverId ?? '', reseedCounter, songsPerCard] as const,
        staleTime: 0,
    });

export const useUnplayedFeatureData = (
    serverId: string | undefined,
    serverType: string | undefined,
    t: TFunction,
): FeatureCardData => {
    // Played.Never is only honored by Jellyfin's controller. Subsonic/
    // Navidrome's getRandomSongList does not forward the played filter, so
    // we'd silently return a random *all*-songs sample under the "Tracks
    // you've never played" label. Surface an explicit empty state rather
    // than misrepresenting the data.
    const unsupported = serverType !== undefined && serverType !== 'jellyfin';
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    // Use the rotation index as a reseed nonce; pool size of 100 is arbitrary —
    // we never have 100 different samples but each reshuffle just increments.
    const { index, reshuffle } = usePoolRotation(unsupported ? 0 : 100);
    const { data: songs, isLoading } = useUnplayedSongs(
        unsupported ? undefined : serverId,
        index,
        songsPerCard,
    );
    if (unsupported) {
        return {
            eyebrow: t('page.home.featureUnplayed_eyebrow'),
            isLoading: false,
            songs: [],
            subtitle: t('page.home.featureVariant_unsupported_subtitle'),
            title: t('page.home.featureVariant_unsupported_title'),
        };
    }
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

const useForgottenFavoritesSongs = (serverId: string | undefined, songsPerCard: number) =>
    useQuery({
        enabled: Boolean(serverId),
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-forgotten',
                serverId ?? '',
                songsPerCard,
            ])) as never,
        queryFn: (ctx) => {
            const key = ['feature-card-forgotten', serverId ?? '', songsPerCard] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!serverId) return [] as Song[];
                    // Favorites sorted by least-recently-played first.
                    // Result is approximate: "favorites you haven't touched
                    // in a while" without needing an absolute date filter.
                    const res = await api.controller.getSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            favorite: true,
                            limit: songsPerCard * 3,
                            sortBy: SongListSort.RECENTLY_PLAYED,
                            sortOrder: SortOrder.ASC,
                            startIndex: 0,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: ['feature-card-forgotten', serverId ?? '', songsPerCard] as const,
        staleTime: 1000 * 60 * 30,
    });

export const useForgottenFavoritesFeatureData = (
    serverId: string | undefined,
    t: TFunction,
): FeatureCardData => {
    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { data: songs, isLoading, refetch } = useForgottenFavoritesSongs(serverId, songsPerCard);
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

const useTimeMachineSongs = (
    year: null | number,
    serverId: string | undefined,
    songsPerCard: number,
) =>
    useQuery({
        enabled: Boolean(year && serverId),
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-time-machine',
                serverId ?? '',
                year ?? 0,
                songsPerCard,
            ])) as never,
        // No keepPreviousData: the auto-skip below can churn the year
        // multiple times in succession. The 2-tier `shown` state below
        // hides those transitions from the user; React-Query keeping
        // stale data here would just confuse the dispatch path.
        queryFn: (ctx) => {
            const key = [
                'feature-card-time-machine',
                serverId ?? '',
                year ?? 0,
                songsPerCard,
            ] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (!year || !serverId) return [] as Song[];
                    const res = await api.controller.getRandomSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            limit: songsPerCard * 3,
                            maxYear: year,
                            minYear: year,
                            played: Played.All,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: ['feature-card-time-machine', serverId ?? '', year ?? 0, songsPerCard] as const,
        staleTime: 1000 * 60 * 5,
    });

// Year pool is wide (~66 years) and most libraries cluster heavily in a few
// recent decades. Six retries hit a populated year ~62% of the time; thirty
// retries push that past 99% on even the sparsest libraries while still being
// O(retries) in network calls, not O(years).
const MAX_AUTO_SKIP_RETRIES = 30;

interface ShownTimeMachine {
    idx: number;
    songs: Song[];
    year: number;
}

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

    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { goNext, goPrev, index, reshuffle } = usePoolRotation(yearPool.length);
    const year = yearPool[index % yearPool.length];
    const {
        data: songs,
        isFetching,
        isLoading,
    } = useTimeMachineSongs(year, serverId, songsPerCard);

    // Two-tier state: the auto-skip below may try several empty years before
    // landing on one with tracks. Without this, the title would flash
    // 1923→1956→1991 while the grid stayed empty. `shown` holds the last
    // year we successfully rendered; we only swap to a new year once its
    // songs are validated.
    const [shown, setShown] = useState<null | ShownTimeMachine>(null);
    const [retriesExhausted, setRetriesExhausted] = useState(false);
    const retryCountRef = useRef(0);
    useEffect(() => {
        // Clear cross-server state.
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
    }, [serverId]);
    useEffect(() => {
        if (isFetching || isLoading || !songs || !year) return;
        if (songs.length > 0) {
            retryCountRef.current = 0;
            setRetriesExhausted(false);
            setShown({ idx: index, songs, year });
            return;
        }
        if (retryCountRef.current < MAX_AUTO_SKIP_RETRIES) {
            retryCountRef.current += 1;
            reshuffle();
        } else {
            // Give up. Surface a generic empty state rather than naming the
            // specific year we just gave up on — that reads as "1962 has
            // nothing" rather than "we couldn't find a populated year".
            setRetriesExhausted(true);
        }
    }, [isFetching, isLoading, reshuffle, songs, year, index]);

    const handlePrev = useCallback(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
        goPrev();
    }, [goPrev]);
    const handleNext = useCallback(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
        goNext();
    }, [goNext]);
    const handleReshuffle = useCallback(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
        reshuffle();
    }, [reshuffle]);

    return {
        eyebrow: t('page.home.featureTimeMachine_eyebrow'),
        isLoading: isLoading || (!shown && !retriesExhausted),
        onNext: yearPool.length > 1 ? handleNext : undefined,
        onPrev: yearPool.length > 1 ? handlePrev : undefined,
        onReshuffle: handleReshuffle,
        rotationCount: yearPool.length,
        rotationIndex: shown?.idx ?? index,
        songs: shown?.songs ?? [],
        subtitle: retriesExhausted ? t('page.home.featureTimeMachine_empty') : undefined,
        title: shown ? String(shown.year) : t('page.home.featureVariant_empty_title'),
    };
};

// ============================================================================
// Decade Dive
// ============================================================================

const useDecadeSongs = (
    decadeStart: null | number,
    serverId: string | undefined,
    songsPerCard: number,
) =>
    useQuery({
        enabled: Boolean(decadeStart !== null && serverId),
        placeholderData: (() =>
            readSnapshot<Song[]>([
                'feature-card-decade',
                serverId ?? '',
                decadeStart ?? -1,
                songsPerCard,
            ])) as never,
        // See useTimeMachineSongs — no keepPreviousData here either.
        queryFn: (ctx) => {
            const key = [
                'feature-card-decade',
                serverId ?? '',
                decadeStart ?? -1,
                songsPerCard,
            ] as const;
            return snapshotSwr<Song[]>({
                ctx,
                queryKey: key,
                remote: async ({ signal }) => {
                    if (decadeStart === null || !serverId) return [] as Song[];
                    const res = await api.controller.getRandomSongList({
                        apiClientProps: { serverId, signal },
                        query: {
                            limit: songsPerCard * 3,
                            maxYear: decadeStart + 9,
                            minYear: decadeStart,
                            played: Played.All,
                        },
                    });
                    await writeSongsToCache((res?.items ?? []) as Song[]);
                    return dedupeSongsByTitle((res?.items ?? []) as Song[]).slice(0, songsPerCard);
                },
            });
        },
        queryKey: ['feature-card-decade', serverId ?? '', decadeStart ?? -1, songsPerCard] as const,
        staleTime: 1000 * 60 * 5,
    });

interface ShownDecade {
    decade: number;
    idx: number;
    songs: Song[];
}

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

    const songsPerCard = useHomeFeatureCardSongsPerCard();
    const { goNext, goPrev, index, reshuffle } = usePoolRotation(decades.length);
    const decade = decades[index % decades.length];
    const { data: songs, isFetching, isLoading } = useDecadeSongs(decade, serverId, songsPerCard);

    // Same 2-tier state machine as time-machine: hide auto-skip transitions
    // from the user. Retry budget = decades.length - 1 so even on a sparse
    // library we exhaustively try every decade before giving up; the
    // previous magic-number 4 left 26% of cold loads stuck on the empty
    // state on libraries with gaps.
    const [shown, setShown] = useState<null | ShownDecade>(null);
    const [retriesExhausted, setRetriesExhausted] = useState(false);
    const retryCountRef = useRef(0);
    const maxRetries = Math.max(decades.length - 1, 1);
    useEffect(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
    }, [serverId]);
    useEffect(() => {
        if (isFetching || isLoading || !songs || decade === undefined) return;
        if (songs.length > 0) {
            retryCountRef.current = 0;
            setRetriesExhausted(false);
            setShown({ decade, idx: index, songs });
            return;
        }
        if (retryCountRef.current < maxRetries) {
            retryCountRef.current += 1;
            reshuffle();
        } else {
            setRetriesExhausted(true);
        }
    }, [isFetching, isLoading, reshuffle, songs, decade, index, maxRetries]);

    const handlePrev = useCallback(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
        goPrev();
    }, [goPrev]);
    const handleNext = useCallback(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
        goNext();
    }, [goNext]);
    const handleReshuffle = useCallback(() => {
        retryCountRef.current = 0;
        setRetriesExhausted(false);
        setShown(null);
        reshuffle();
    }, [reshuffle]);

    return {
        eyebrow: t('page.home.featureDecade_eyebrow'),
        isLoading: isLoading || (!shown && !retriesExhausted),
        onNext: decades.length > 1 ? handleNext : undefined,
        onPrev: decades.length > 1 ? handlePrev : undefined,
        onReshuffle: handleReshuffle,
        rotationCount: decades.length,
        rotationIndex: shown?.idx ?? index,
        songs: shown?.songs ?? [],
        subtitle: retriesExhausted
            ? t('page.home.featureTimeMachine_empty')
            : t('page.home.featureDecade_subtitle'),
        title: shown ? `${shown.decade}s` : t('page.home.featureVariant_empty_title'),
    };
};
