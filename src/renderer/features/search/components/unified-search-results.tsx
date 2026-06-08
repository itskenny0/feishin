import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useDeferredValue, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link, useSearchParams } from 'react-router';

import styles from './unified-search-results.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { searchQueries } from '/@/renderer/features/search/api/search-api';
import { EmptyState } from '/@/renderer/features/shared/components/empty-state';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId } from '/@/renderer/store';
import { formatDurationString } from '/@/renderer/utils/format';
import { Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';
import { Album, AlbumArtist, LibraryItem, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

// Page size matches SEARCH_PAGE_SIZE in search-api. We fetch a second page per
// section (via fetchNextPage once) so each row/grid shows ~8 items.
const SECTION_LIMIT = 8;

type TopResult =
    | null
    | { item: Album; kind: LibraryItem.ALBUM }
    | { item: AlbumArtist; kind: LibraryItem.ALBUM_ARTIST }
    | { item: Song; kind: LibraryItem.SONG };

const albumDetailPath = (id: string) =>
    generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: id });

const artistDetailPath = (id: string) =>
    generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, { albumArtistId: id });

// "See all" deep-links into the per-entity search list route the rest of the
// app already serves: /search/<itemType>?query=<encoded query>.
const seeAllTo = (itemType: LibraryItem, query: string) => ({
    pathname: generatePath(AppRoute.SEARCH, { itemType }),
    search: `?query=${encodeURIComponent(query)}`,
});

const joinArtists = (artists: { name: string }[]): string => artists.map((a) => a.name).join(', ');

/**
 * Unified, responsive search RESULTS page (Spotify-flavoured). Renders inside
 * the app shell as page content — no modal / router / overlay of its own.
 *
 * - Empty query → the shared SearchPrompt empty state (same as the dedicated
 *   /search tabs use today).
 * - With a query → a spotlight zone (Top result + Songs list) followed by
 *   Albums and Artists grids, each with a "See all" affordance.
 *
 * Reflow is pure CSS: the spotlight is a single column on phones (Top result
 * full-width above the song list) and a two-column grid on wide viewports
 * (Top result beside the songs); the album/artist grids use auto-fill tracks
 * so they go from 2-up on a phone to many columns on desktop.
 */
export const UnifiedSearchResults = () => {
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const query = searchParams.get('query') || '';
    const deferredQuery = useDeferredValue(query);
    const serverId = useCurrentServerId();
    const { addToQueueByData } = usePlayer();

    const enabled = deferredQuery.trim() !== '';

    const songsQuery = useInfiniteQuery(
        searchQueries.searchSongsInfinite({ enabled, searchTerm: deferredQuery, serverId }),
    );
    const albumsQuery = useInfiniteQuery(
        searchQueries.searchAlbumsInfinite({ enabled, searchTerm: deferredQuery, serverId }),
    );
    const artistsQuery = useInfiniteQuery(
        searchQueries.searchAlbumArtistsInfinite({ enabled, searchTerm: deferredQuery, serverId }),
    );

    // Fetch a second page (page size is 4) so each section can show ~8 items.
    // Guarded by the fetching flag so we don't loop while a page is in flight.
    useEffect(() => {
        if (songsQuery.hasNextPage && !songsQuery.isFetchingNextPage) songsQuery.fetchNextPage();
    }, [songsQuery.hasNextPage, songsQuery.isFetchingNextPage, songsQuery]);
    useEffect(() => {
        if (albumsQuery.hasNextPage && !albumsQuery.isFetchingNextPage) albumsQuery.fetchNextPage();
    }, [albumsQuery.hasNextPage, albumsQuery.isFetchingNextPage, albumsQuery]);
    useEffect(() => {
        if (artistsQuery.hasNextPage && !artistsQuery.isFetchingNextPage)
            artistsQuery.fetchNextPage();
    }, [artistsQuery.hasNextPage, artistsQuery.isFetchingNextPage, artistsQuery]);

    const songs = useMemo(
        () => (songsQuery.data?.pages.flatMap((p) => p.songs) ?? []).slice(0, SECTION_LIMIT),
        [songsQuery.data?.pages],
    );
    const albums = useMemo(
        () => (albumsQuery.data?.pages.flatMap((p) => p.albums) ?? []).slice(0, SECTION_LIMIT),
        [albumsQuery.data?.pages],
    );
    const artists = useMemo(
        () =>
            (artistsQuery.data?.pages.flatMap((p) => p.albumArtists) ?? []).slice(0, SECTION_LIMIT),
        [artistsQuery.data?.pages],
    );

    // Top result heuristic: prefer an exact (case-insensitive) name match,
    // searching artists → albums → songs in priority order; otherwise fall
    // back to the first artist, then first album, then first song.
    const topResult: TopResult = useMemo(() => {
        const needle = deferredQuery.trim().toLowerCase();
        const exact = (name: string) => name.trim().toLowerCase() === needle;

        if (needle) {
            const artist = artists.find((a) => exact(a.name));
            if (artist) return { item: artist, kind: LibraryItem.ALBUM_ARTIST };
            const album = albums.find((a) => exact(a.name));
            if (album) return { item: album, kind: LibraryItem.ALBUM };
            const song = songs.find((s) => exact(s.name));
            if (song) return { item: song, kind: LibraryItem.SONG };
        }

        if (artists[0]) return { item: artists[0], kind: LibraryItem.ALBUM_ARTIST };
        if (albums[0]) return { item: albums[0], kind: LibraryItem.ALBUM };
        if (songs[0]) return { item: songs[0], kind: LibraryItem.SONG };
        return null;
    }, [albums, artists, deferredQuery, songs]);

    const playSong = useCallback(
        (song: Song) => {
            if (serverId) addToQueueByData([song], Play.NOW);
        },
        [addToQueueByData, serverId],
    );

    const anyLoading = songsQuery.isLoading || albumsQuery.isLoading || artistsQuery.isLoading;
    const totalResults = songs.length + albums.length + artists.length;

    // Empty query → the shared search prompt (identical to the /search tabs).
    if (query.trim().length === 0) {
        return (
            <div className={styles.root}>
                <SearchPrompt />
            </div>
        );
    }

    if (anyLoading && totalResults === 0) {
        return (
            <div className={styles.root}>
                <ResultsSkeleton />
            </div>
        );
    }

    if (!anyLoading && totalResults === 0) {
        return (
            <div className={styles.root}>
                <EmptyState
                    description={t('emptyState.searchDescription', {
                        defaultValue: "We couldn't find anything matching that search.",
                    })}
                    icon="search"
                    title={t('emptyState.searchTitle', { defaultValue: 'No results' })}
                />
            </div>
        );
    }

    return (
        <div className={styles.root}>
            <div className={styles.page}>
                {/* Spotlight: Top result beside the song list on desktop. */}
                <div className={styles.spotlight}>
                    {topResult ? (
                        <section className={styles.topSection}>
                            <SectionHeader
                                title={t('page.globalSearch.topResult', {
                                    defaultValue: 'Top result',
                                })}
                            />
                            <TopResultCard onPlay={playSong} result={topResult} />
                        </section>
                    ) : null}

                    {songs.length > 0 ? (
                        <section className={styles.songsSection}>
                            <SectionHeader
                                seeAllLabel={t('action.viewAll', { defaultValue: 'See all' })}
                                seeAllTo={seeAllTo(LibraryItem.SONG, query)}
                                title={t('entity.track', { count: 2, defaultValue: 'Songs' })}
                            />
                            <div className={styles.songList}>
                                {songs.map((song) => (
                                    <SongRow key={song.id} onPlay={playSong} song={song} />
                                ))}
                            </div>
                        </section>
                    ) : null}
                </div>

                {albums.length > 0 ? (
                    <section className={styles.gridSection}>
                        <SectionHeader
                            seeAllLabel={t('action.viewAll', { defaultValue: 'See all' })}
                            seeAllTo={seeAllTo(LibraryItem.ALBUM, query)}
                            title={t('entity.album', { count: 2, defaultValue: 'Albums' })}
                        />
                        <div className={styles.cardGrid}>
                            {albums.map((album) => (
                                <AlbumCard album={album} key={album.id} />
                            ))}
                        </div>
                    </section>
                ) : null}

                {artists.length > 0 ? (
                    <section className={styles.gridSection}>
                        <SectionHeader
                            seeAllLabel={t('action.viewAll', { defaultValue: 'See all' })}
                            seeAllTo={seeAllTo(LibraryItem.ALBUM_ARTIST, query)}
                            title={t('entity.albumArtist', { count: 2, defaultValue: 'Artists' })}
                        />
                        <div className={`${styles.cardGrid} ${styles.cardGridArtists}`}>
                            {artists.map((artist) => (
                                <ArtistCard artist={artist} key={artist.id} />
                            ))}
                        </div>
                    </section>
                ) : null}
            </div>
        </div>
    );
};

interface SectionHeaderProps {
    seeAllLabel?: string;
    seeAllTo?: { pathname: string; search: string };
    title: string;
}

const SectionHeader = ({ seeAllLabel, seeAllTo: to, title }: SectionHeaderProps) => (
    <div className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {to ? (
            <Link className={styles.seeAll} to={to}>
                {seeAllLabel}
                <Icon className={styles.seeAllIcon} icon="arrowRightS" />
            </Link>
        ) : null}
    </div>
);

interface TopResultCardProps {
    onPlay: (song: Song) => void;
    result: NonNullable<TopResult>;
}

const TopResultCard = ({ onPlay, result }: TopResultCardProps) => {
    const { t } = useTranslation();
    const { item, kind } = result;
    const isArtist = kind === LibraryItem.ALBUM_ARTIST;
    const isSong = kind === LibraryItem.SONG;

    const subtitle =
        kind === LibraryItem.ALBUM_ARTIST
            ? t('entity.albumArtist', { count: 1, defaultValue: 'Artist' })
            : kind === LibraryItem.ALBUM
              ? joinArtists((item as Album).albumArtists) ||
                t('entity.album', { count: 1, defaultValue: 'Album' })
              : joinArtists((item as Song).artists) ||
                t('entity.track', { count: 1, defaultValue: 'Song' });

    const imageId = item.imageId;
    const imageUrl = item.imageUrl;

    const Inner = (
        <>
            <div className={styles.topImageWrap}>
                <ItemImage
                    alt={item.name}
                    className={`${styles.topImage} ${isArtist ? styles.topImageRound : ''}`}
                    explicitStatus={isArtist ? null : (item as Album | Song).explicitStatus}
                    height={120}
                    id={imageId}
                    itemType={kind}
                    src={imageUrl}
                    type="itemCard"
                    width={120}
                />
            </div>
            <div className={styles.topBody}>
                <Text className={styles.topName}>{item.name}</Text>
                <Text className={styles.topSubtitle} isMuted>
                    {subtitle}
                </Text>
            </div>
            {isSong ? (
                <button
                    aria-label={t('player.play', { defaultValue: 'Play' })}
                    className={styles.topPlay}
                    onClick={(e) => {
                        e.preventDefault();
                        onPlay(item as Song);
                    }}
                    type="button"
                >
                    <Icon icon="mediaPlay" />
                </button>
            ) : (
                <span aria-hidden className={styles.topPlay}>
                    <Icon icon="arrowRightS" />
                </span>
            )}
        </>
    );

    // A song top result plays on click; album/artist navigate to detail.
    if (isSong) {
        return (
            <button
                className={`${styles.topCard} ${styles.topCardButton}`}
                onClick={() => onPlay(item as Song)}
                type="button"
            >
                {Inner}
            </button>
        );
    }

    return (
        <Link
            className={styles.topCard}
            to={isArtist ? artistDetailPath(item.id) : albumDetailPath(item.id)}
        >
            {Inner}
        </Link>
    );
};

interface SongRowProps {
    onPlay: (song: Song) => void;
    song: Song;
}

const SongRow = ({ onPlay, song }: SongRowProps) => {
    const { t } = useTranslation();
    return (
        <button className={styles.songRow} onClick={() => onPlay(song)} type="button">
            <div className={styles.songThumbWrap}>
                <ItemImage
                    alt={song.name}
                    className={styles.songThumb}
                    explicitStatus={song.explicitStatus}
                    height={40}
                    id={song.imageId}
                    itemType={LibraryItem.SONG}
                    src={song.imageUrl}
                    type="table"
                    width={40}
                />
                <span aria-hidden className={styles.songThumbPlay}>
                    <Icon icon="mediaPlay" />
                </span>
            </div>
            <div className={styles.songText}>
                <Text className={styles.songTitle}>{song.name}</Text>
                <Text className={styles.songArtist} isMuted size="sm">
                    {joinArtists(song.artists)}
                </Text>
            </div>
            <Text aria-hidden className={styles.songDuration} isMuted size="sm">
                {song.duration ? formatDurationString(song.duration) : ''}
            </Text>
            <span className={styles.srOnly}>{t('player.play', { defaultValue: 'Play' })}</span>
        </button>
    );
};

const AlbumCard = ({ album }: { album: Album }) => (
    <Link className={styles.card} to={albumDetailPath(album.id)}>
        <div className={styles.cardArtWrap}>
            <ItemImage
                alt={album.name}
                className={styles.cardArt}
                explicitStatus={album.explicitStatus}
                height={200}
                id={album.imageId}
                itemType={LibraryItem.ALBUM}
                src={album.imageUrl}
                type="itemCard"
                width={200}
            />
            <span aria-hidden className={styles.cardPlay}>
                <Icon icon="mediaPlay" />
            </span>
        </div>
        <Text className={styles.cardTitle}>{album.name}</Text>
        <Text className={styles.cardSubtitle} isMuted size="sm">
            {joinArtists(album.albumArtists)}
        </Text>
    </Link>
);

const ArtistCard = ({ artist }: { artist: AlbumArtist }) => {
    const { t } = useTranslation();
    return (
        <Link className={styles.card} to={artistDetailPath(artist.id)}>
            <div className={`${styles.cardArtWrap} ${styles.cardArtWrapRound}`}>
                <ItemImage
                    alt={artist.name}
                    className={`${styles.cardArt} ${styles.cardArtRound}`}
                    height={200}
                    id={artist.imageId}
                    itemType={LibraryItem.ALBUM_ARTIST}
                    src={artist.imageUrl}
                    type="itemCard"
                    width={200}
                />
            </div>
            <Text className={`${styles.cardTitle} ${styles.cardTitleCenter}`}>{artist.name}</Text>
            <Text className={`${styles.cardSubtitle} ${styles.cardTitleCenter}`} isMuted size="sm">
                {t('entity.albumArtist', { count: 1, defaultValue: 'Artist' })}
            </Text>
        </Link>
    );
};

const SearchPrompt = () => {
    const { t } = useTranslation();
    return (
        <EmptyState
            description={t('emptyState.searchPromptDescription', {
                defaultValue: 'Find songs, albums, and artists.',
            })}
            icon="search"
            title={t('emptyState.searchPromptTitle', { defaultValue: 'Search your library' })}
        />
    );
};

/** Per-section skeleton shown while the first page of every section loads. */
const ResultsSkeleton = () => (
    <div className={styles.page}>
        <div className={styles.spotlight}>
            <section className={styles.topSection}>
                <div className={styles.skelHeader} />
                <div className={`${styles.skel} ${styles.skelTopCard}`} />
            </section>
            <section className={styles.songsSection}>
                <div className={styles.skelHeader} />
                <div className={styles.songList}>
                    {Array.from({ length: 5 }).map((_, i) => (
                        <div className={styles.skelSongRow} key={i}>
                            <div className={`${styles.skel} ${styles.skelThumb}`} />
                            <div className={styles.skelLines}>
                                <div className={`${styles.skel} ${styles.skelLine}`} />
                                <div className={`${styles.skel} ${styles.skelLineShort}`} />
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
        <section className={styles.gridSection}>
            <div className={styles.skelHeader} />
            <div className={styles.cardGrid}>
                {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i}>
                        <div className={`${styles.skel} ${styles.skelCardArt}`} />
                        <div className={`${styles.skel} ${styles.skelLine}`} />
                        <div className={`${styles.skel} ${styles.skelLineShort}`} />
                    </div>
                ))}
            </div>
        </section>
    </div>
);

export default UnifiedSearchResults;
