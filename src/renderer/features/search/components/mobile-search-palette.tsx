import { openModal } from '@mantine/modals';
import { useInfiniteQuery } from '@tanstack/react-query';
import { t } from 'i18next';
import { nanoid } from 'nanoid/non-secure';
import { Dispatch, useCallback, useDeferredValue, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { createSearchParams, generatePath, useNavigate } from 'react-router';

import styles from './mobile-search-palette.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { MotionDiv } from '/@/renderer/components/motion';
import { isServerLock } from '/@/renderer/features/action-required/utils/window-properties';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { openCreatePlaylistModal } from '/@/renderer/features/playlists/components/create-playlist-form';
import { searchQueries } from '/@/renderer/features/search/api/search-api';
import { CommandPalettePages } from '/@/renderer/features/search/components/command';
import { ServerList } from '/@/renderer/features/servers/components/server-list';
import { openSettingsModal } from '/@/renderer/features/settings/utils/open-settings-modal';
import { HighlightedText } from '/@/renderer/features/shared/components/highlighted-text';
import { FILTER_KEYS } from '/@/renderer/features/shared/utils';
import { AppRoute } from '/@/renderer/router/routes';
import { useAuthStoreActions, useCurrentServer, useServerList } from '/@/renderer/store';
import { useShowFilesystemNameForAlbums } from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Icon } from '/@/shared/components/icon/icon';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem, ServerListItemWithCredential } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

const folderNameFromAlbumPath = (path?: null | string): null | string => {
    if (!path) return null;
    const segments = path.split(/[/\\]/).filter(Boolean);
    if (segments.length === 0) return null;
    return segments[segments.length - 1];
};

interface MobileSearchPaletteProps {
    handleClose: () => void;
    onSelectResult: () => void;
    pages: CommandPalettePages[];
    query: string;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    setPages: Dispatch<CommandPalettePages[]>;
    setQuery: (query: string) => void;
}

/**
 * A native, tappable mobile row used throughout the mobile search surface.
 * Renders cover art (or a leading icon tile for command rows), a title and an
 * optional subtitle, with a generous touch target. Pressed/active feedback
 * lives in CSS (`.row:active`) — no desktop hover/keyboard-selection state.
 */
interface MobileSearchRowProps {
    explicitStatus?: Parameters<typeof ItemImage>[0]['explicitStatus'];
    highlightQuery?: string;
    imageId?: null | string;
    imageUrl?: null | string;
    index: number;
    itemType?: LibraryItem;
    leadingIcon?: Parameters<typeof Icon>[0]['icon'];
    onSelect: () => void;
    round?: boolean;
    showChevron?: boolean;
    subtitle?: string;
    title: string;
}

interface MobileSubPageNavProps {
    handleClose: () => void;
    setPages: Dispatch<CommandPalettePages[]>;
    setQuery: (query: string) => void;
}

interface MobileSubPageProps {
    children: React.ReactNode;
    onBack: () => void;
    onClose: () => void;
    title: string;
}

interface ResultsSectionProps {
    debouncedQuery: string;
    onSelectResult: () => void;
    query: string;
}

interface SectionHeadingProps {
    onSeeAll?: () => void;
    title: string;
}

/**
 * Native "Go to page" sub-page. Mirrors GoToCommands' destinations + handlers
 * exactly (navigate + close + reset to HOME), rendered as native rows.
 */
export function MobileGoToPage({ handleClose, setPages, setQuery }: MobileSubPageNavProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();

    const goTo = useCallback(
        (route: string) => {
            navigate(route);
            handleClose();
            setPages([CommandPalettePages.HOME]);
            setQuery('');
        },
        [handleClose, navigate, setPages, setQuery],
    );

    const items: {
        icon: Parameters<typeof Icon>[0]['icon'];
        label: string;
        onSelect: () => void;
    }[] = [
        { icon: 'home', label: t('page.sidebar.home'), onSelect: () => goTo(AppRoute.HOME) },
        {
            icon: 'search',
            label: t('page.sidebar.search'),
            onSelect: () => goTo(AppRoute.SEARCH_INDEX),
        },
        {
            icon: 'settings',
            label: t('page.sidebar.settings'),
            onSelect: () => openSettingsModal(),
        },
        {
            icon: 'album',
            label: t('page.sidebar.albums'),
            onSelect: () => goTo(AppRoute.LIBRARY_ALBUMS),
        },
        {
            icon: 'itemAlbum',
            label: t('page.sidebar.tracks'),
            onSelect: () => goTo(AppRoute.LIBRARY_SONGS),
        },
        {
            icon: 'artist',
            label: t('page.sidebar.albumArtists'),
            onSelect: () => goTo(AppRoute.LIBRARY_ALBUM_ARTISTS),
        },
        {
            icon: 'menu',
            label: t('page.sidebar.genres'),
            onSelect: () => goTo(AppRoute.LIBRARY_GENRES),
        },
        {
            icon: 'folderClosed',
            label: t('page.sidebar.folders'),
            onSelect: () => goTo(AppRoute.LIBRARY_FOLDERS),
        },
        {
            icon: 'playlist',
            label: t('page.sidebar.playlists'),
            onSelect: () => goTo(AppRoute.PLAYLISTS),
        },
    ];

    return (
        <MobileSubPage
            onBack={() => setPages([CommandPalettePages.HOME])}
            onClose={handleClose}
            title={t('page.globalSearch.commands.goToPage', { defaultValue: 'Go to page' })}
        >
            {items.map((item, index) => (
                <MobileSearchRow
                    index={index}
                    key={item.label}
                    leadingIcon={item.icon}
                    onSelect={item.onSelect}
                    showChevron
                    title={item.label}
                />
            ))}
        </MobileSubPage>
    );
}

/**
 * Dedicated mobile search page. Rendered INSTEAD of the desktop cmdk layout
 * when the app is on the mobile shell (gated upstream in command-palette.tsx).
 *
 * - Zero query → command rows (Search…, Create Playlist…, Go to page…, Server
 *   commands…) styled like a native settings list. Reuses the exact same
 *   handlers/navigation as HomeCommands / the cmdk pages.
 * - With a query → flat native result rows grouped by quiet section headers.
 *   Reuses the same searchQueries infinite queries + navigation as the desktop
 *   sections.
 */
export function MobileSearchPalette({
    handleClose,
    onSelectResult,
    query,
    searchInputRef,
    setPages,
    setQuery,
}: MobileSearchPaletteProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const server = useCurrentServer();
    const deferredQuery = useDeferredValue(query);
    const hasQuery = query.trim() !== '';

    // Focus the search field on mount so the soft keyboard pops immediately
    // when the palette opens from the bottom tab bar. The input's
    // `data-autofocus` only works inside a Mantine focus trap — and this
    // palette is a routed PAGE (/command), so nothing else ever focuses it.
    // rAF defers past the route transition's first paint; preventScroll keeps
    // the header from jumping under the keyboard animation.
    useEffect(() => {
        // Immediately, then again next frame — the page-transition animation
        // can steal focus right after mount on the Android WebView.
        searchInputRef.current?.focus({ preventScroll: true });
        const frame = requestAnimationFrame(() => {
            searchInputRef.current?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
        // Mount-only: re-focusing on later renders would steal focus back
        // from result rows the user tabbed/clicked into.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSearchPage = useCallback(() => {
        navigate(
            {
                pathname: AppRoute.SEARCH_INDEX,
                search: createSearchParams({ query }).toString(),
            },
            { state: { navigationId: nanoid() } },
        );
        onSelectResult();
    }, [navigate, onSelectResult, query]);

    const handleCreatePlaylist = useCallback(() => {
        handleClose();
        openCreatePlaylistModal(server);
    }, [handleClose, server]);

    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <ActionIcon
                    aria-label={t('common.close', { defaultValue: 'Close' })}
                    className={styles.backButton}
                    icon="arrowDownS"
                    onClick={handleClose}
                    size="lg"
                    variant="subtle"
                />
                <TextInput
                    aria-label={t('page.sidebar.search', { defaultValue: 'Search' })}
                    className={styles.searchField}
                    data-autofocus
                    leftSection={<Icon icon="search" />}
                    onChange={(e) => setQuery(e.currentTarget.value)}
                    placeholder={t('page.search.placeholder', {
                        defaultValue: 'Songs, albums, artists, playlists…',
                    })}
                    ref={searchInputRef}
                    rightSection={
                        query ? (
                            <ActionIcon
                                aria-label={t('common.clear')}
                                icon="x"
                                onClick={() => {
                                    setQuery('');
                                    searchInputRef.current?.focus();
                                }}
                                variant="transparent"
                            />
                        ) : null
                    }
                    size="md"
                    value={query}
                />
            </div>

            <MotionDiv
                animate={{ opacity: 1, y: 0 }}
                className={styles.scroll}
                initial={{ opacity: 0, y: 12 }}
                key={hasQuery ? 'results' : 'commands'}
                transition={{ duration: 0.18, ease: 'easeOut' }}
            >
                {hasQuery ? (
                    <MobileResults
                        debouncedQuery={deferredQuery}
                        onSelectResult={onSelectResult}
                        query={query}
                    />
                ) : (
                    <>
                        <MobileSearchRow
                            index={0}
                            leadingIcon="search"
                            onSelect={handleSearchPage}
                            showChevron
                            title={`${t('common.search')}...`}
                        />
                        <MobileSearchRow
                            index={1}
                            leadingIcon="playlist"
                            onSelect={handleCreatePlaylist}
                            showChevron
                            title={`${t('action.createPlaylist')}...`}
                        />
                        <MobileSearchRow
                            index={2}
                            leadingIcon="goToItem"
                            onSelect={() => setPages([CommandPalettePages.GO_TO])}
                            showChevron
                            title={`${t('page.globalSearch.commands.goToPage')}...`}
                        />
                        <MobileSearchRow
                            index={3}
                            leadingIcon="server"
                            onSelect={() => setPages([CommandPalettePages.MANAGE_SERVERS])}
                            showChevron
                            title={`${t('page.globalSearch.commands.serverCommands')}...`}
                        />
                    </>
                )}
            </MotionDiv>
        </div>
    );
}

/**
 * Native "Server commands" sub-page. Mirrors ServerCommands' behaviour
 * (select server / manage servers) with the same handlers, as native rows.
 */
export function MobileServerPage({ handleClose, setPages, setQuery }: MobileSubPageNavProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const serverList = useServerList();
    const { setCurrentServer } = useAuthStoreActions();

    const handleManageServersModal = useCallback(() => {
        openModal({
            children: <ServerList />,
            title: t('page.appMenu.manageServers'),
        });
        handleClose();
        setQuery('');
        setPages([CommandPalettePages.HOME]);
    }, [handleClose, setPages, setQuery, t]);

    const handleSelectServer = useCallback(
        (selected: ServerListItemWithCredential) => {
            navigate(AppRoute.HOME);
            setCurrentServer(selected);
            handleClose();
            setQuery('');
            setPages([CommandPalettePages.HOME]);
        },
        [handleClose, navigate, setCurrentServer, setPages, setQuery],
    );

    const serverKeys = Object.keys(serverList);

    return (
        <MobileSubPage
            onBack={() => setPages([CommandPalettePages.HOME])}
            onClose={handleClose}
            title={t('page.appMenu.selectServer', { defaultValue: 'Select server' })}
        >
            {serverKeys.map((key, index) => (
                <MobileSearchRow
                    index={index}
                    key={key}
                    leadingIcon="server"
                    onSelect={() => handleSelectServer(serverList[key])}
                    showChevron
                    title={`${serverList[key].name}...`}
                />
            ))}
            {!isServerLock() ? (
                <MobileSearchRow
                    index={serverKeys.length}
                    leadingIcon="menu"
                    onSelect={handleManageServersModal}
                    showChevron
                    title={`${t('page.appMenu.manageServers')}...`}
                />
            ) : null}
        </MobileSubPage>
    );
}

/** Album results as native rows. Reuses searchAlbumsInfinite + nav logic. */
function AlbumResults({ debouncedQuery, onSelectResult, query }: ResultsSectionProps) {
    const navigate = useNavigate();
    const server = useCurrentServer();
    const { t } = useTranslation();
    const useFsForAlbums = useShowFilesystemNameForAlbums();

    const { data, isLoading } = useInfiniteQuery(
        searchQueries.searchAlbumsInfinite({
            enabled: debouncedQuery !== '' && query !== '',
            searchTerm: debouncedQuery,
            serverId: server?.id,
        }),
    );

    const albums = useMemo(() => data?.pages.flatMap((p) => p.albums) ?? [], [data?.pages]);

    const handleSeeAll = useCallback(() => {
        navigate(
            {
                pathname: AppRoute.LIBRARY_ALBUMS,
                search: createSearchParams({
                    [FILTER_KEYS.SHARED.SEARCH_TERM]: debouncedQuery || query,
                }).toString(),
            },
            { state: { navigationId: nanoid() } },
        );
        onSelectResult();
    }, [debouncedQuery, navigate, onSelectResult, query]);

    if (isLoading) {
        return (
            <>
                <SectionHeading title={t('entity.album', { count: 2 })} />
                <div className={styles.sectionSpinner}>
                    <Spinner />
                </div>
            </>
        );
    }

    if (albums.length === 0) return null;

    return (
        <>
            <SectionHeading onSeeAll={handleSeeAll} title={t('entity.album', { count: 2 })} />
            {albums.map((album, index) => (
                <MobileSearchRow
                    explicitStatus={album.explicitStatus}
                    highlightQuery={debouncedQuery}
                    imageId={album.imageId}
                    imageUrl={album.imageUrl}
                    index={index}
                    itemType={LibraryItem.ALBUM}
                    key={`m-album-${album.id}`}
                    onSelect={() => {
                        navigate(
                            generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId: album.id }),
                        );
                        onSelectResult();
                    }}
                    subtitle={album.albumArtists.map((artist) => artist.name).join(', ')}
                    title={
                        (useFsForAlbums ? folderNameFromAlbumPath(album.path) : null) || album.name
                    }
                />
            ))}
        </>
    );
}

/** Album-artist results as native rows. Reuses searchAlbumArtistsInfinite. */
function ArtistResults({ debouncedQuery, onSelectResult, query }: ResultsSectionProps) {
    const navigate = useNavigate();
    const server = useCurrentServer();
    const { t } = useTranslation();

    const { data, isLoading } = useInfiniteQuery(
        searchQueries.searchAlbumArtistsInfinite({
            enabled: debouncedQuery !== '' && query !== '',
            searchTerm: debouncedQuery,
            serverId: server?.id,
        }),
    );

    const artists = useMemo(() => data?.pages.flatMap((p) => p.albumArtists) ?? [], [data?.pages]);

    const handleSeeAll = useCallback(() => {
        navigate(
            {
                pathname: AppRoute.LIBRARY_ALBUM_ARTISTS,
                search: createSearchParams({
                    [FILTER_KEYS.SHARED.SEARCH_TERM]: debouncedQuery || query,
                }).toString(),
            },
            { state: { navigationId: nanoid() } },
        );
        onSelectResult();
    }, [debouncedQuery, navigate, onSelectResult, query]);

    if (isLoading) {
        return (
            <>
                <SectionHeading title={t('entity.albumArtist', { count: 2 })} />
                <div className={styles.sectionSpinner}>
                    <Spinner />
                </div>
            </>
        );
    }

    if (artists.length === 0) return null;

    return (
        <>
            <SectionHeading onSeeAll={handleSeeAll} title={t('entity.albumArtist', { count: 2 })} />
            {artists.map((artist, index) => (
                <MobileSearchRow
                    highlightQuery={debouncedQuery}
                    imageId={artist.imageId}
                    imageUrl={artist.imageUrl}
                    index={index}
                    itemType={LibraryItem.ALBUM_ARTIST}
                    key={`m-artist-${artist.id}`}
                    onSelect={() => {
                        navigate(
                            generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
                                albumArtistId: artist.id,
                            }),
                        );
                        onSelectResult();
                    }}
                    round
                    subtitle={
                        artist?.albumCount !== undefined && artist?.albumCount !== null
                            ? t('entity.albumWithCount', { count: artist.albumCount })
                            : undefined
                    }
                    title={artist.name}
                />
            ))}
        </>
    );
}

/**
 * Aggregate results view. Renders the three flat native sections and, once all
 * three queries have settled with no hits, a friendly empty state instead of a
 * blank scroll area. The extra useInfiniteQuery calls here share TanStack's
 * cache with the section components (identical query keys), so no additional
 * network requests are issued.
 */
function MobileResults({ debouncedQuery, onSelectResult, query }: ResultsSectionProps) {
    const server = useCurrentServer();
    const { t } = useTranslation();
    const enabled = debouncedQuery !== '' && query !== '';

    const songs = useInfiniteQuery(
        searchQueries.searchSongsInfinite({
            enabled,
            searchTerm: debouncedQuery,
            serverId: server?.id,
        }),
    );
    const albums = useInfiniteQuery(
        searchQueries.searchAlbumsInfinite({
            enabled,
            searchTerm: debouncedQuery,
            serverId: server?.id,
        }),
    );
    const artists = useInfiniteQuery(
        searchQueries.searchAlbumArtistsInfinite({
            enabled,
            searchTerm: debouncedQuery,
            serverId: server?.id,
        }),
    );

    const anyLoading = songs.isLoading || albums.isLoading || artists.isLoading;
    const totalResults =
        (songs.data?.pages.flatMap((p) => p.songs).length ?? 0) +
        (albums.data?.pages.flatMap((p) => p.albums).length ?? 0) +
        (artists.data?.pages.flatMap((p) => p.albumArtists).length ?? 0);

    return (
        <>
            <SongResults
                debouncedQuery={debouncedQuery}
                onSelectResult={onSelectResult}
                query={query}
            />
            <AlbumResults
                debouncedQuery={debouncedQuery}
                onSelectResult={onSelectResult}
                query={query}
            />
            <ArtistResults
                debouncedQuery={debouncedQuery}
                onSelectResult={onSelectResult}
                query={query}
            />
            {!anyLoading && totalResults === 0 ? (
                <div className={styles.empty}>
                    <Icon className={styles.emptyIcon} icon="search" size="2xl" />
                    <Text isMuted>
                        {t('page.globalSearch.noResults', {
                            defaultValue: 'No results found',
                        })}
                    </Text>
                </div>
            ) : null}
        </>
    );
}

function MobileSearchRow({
    explicitStatus,
    highlightQuery,
    imageId,
    imageUrl,
    index,
    itemType,
    leadingIcon,
    onSelect,
    round,
    showChevron,
    subtitle,
    title,
}: MobileSearchRowProps) {
    return (
        <button
            className={`${styles.row} ${styles.stagger}`}
            onClick={onSelect}
            style={{ animationDelay: `${Math.min(index, 12) * 18}ms` }}
            type="button"
        >
            {leadingIcon ? (
                <div className={styles.rowIconTile}>
                    <Icon icon={leadingIcon} size="lg" />
                </div>
            ) : (
                <div className={styles.rowImageWrapper}>
                    <ItemImage
                        alt="cover"
                        className={`${styles.rowImage} ${round ? styles.rowImageRound : ''}`}
                        explicitStatus={explicitStatus ?? null}
                        height={48}
                        id={imageId}
                        itemType={itemType ?? LibraryItem.ALBUM}
                        src={imageUrl}
                        type="table"
                        width={48}
                    />
                </div>
            )}
            <div className={styles.rowText}>
                <Text className={styles.rowTitle}>
                    <HighlightedText query={highlightQuery} text={title} />
                </Text>
                {subtitle ? (
                    <Text className={styles.rowSubtitle} isMuted size="sm">
                        <HighlightedText query={highlightQuery} text={subtitle} />
                    </Text>
                ) : null}
            </div>
            {showChevron ? (
                <div className={styles.rowTrailing}>
                    <Icon icon="arrowRightS" />
                </div>
            ) : null}
        </button>
    );
}

/**
 * Native shell for the Go-to / Server sub-pages on mobile. Provides the sticky
 * header with a back affordance to pop one page and a close affordance to
 * dismiss the whole palette.
 */
function MobileSubPage({ children, onBack, onClose, title }: MobileSubPageProps) {
    const { t } = useTranslation();
    return (
        <div className={styles.root}>
            <div className={styles.header}>
                <ActionIcon
                    aria-label={t('common.back', { defaultValue: 'Back' })}
                    className={styles.backButton}
                    icon="arrowLeft"
                    onClick={onBack}
                    size="lg"
                    variant="subtle"
                />
                <Text fw={600}>{title}</Text>
                <div style={{ flex: '1 1 auto' }} />
                <ActionIcon
                    aria-label={t('common.close', { defaultValue: 'Close' })}
                    icon="x"
                    onClick={onClose}
                    size="lg"
                    variant="subtle"
                />
            </div>
            <MotionDiv
                animate={{ opacity: 1, y: 0 }}
                className={styles.scroll}
                initial={{ opacity: 0, y: 12 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
            >
                {children}
            </MotionDiv>
        </div>
    );
}

function SectionHeading({ onSeeAll, title }: SectionHeadingProps) {
    return (
        <div className={styles.sectionHeading}>
            <Text fw={600}>{title}</Text>
            {onSeeAll ? (
                <ActionIcon
                    aria-label={t('action.viewMore', { defaultValue: 'View more' })}
                    className={styles.seeAll}
                    icon="arrowRightS"
                    onClick={onSeeAll}
                    variant="subtle"
                />
            ) : null}
        </div>
    );
}

/** Song results as native rows. Reuses searchSongsInfinite; tap plays now. */
function SongResults({ debouncedQuery, onSelectResult, query }: ResultsSectionProps) {
    const server = useCurrentServer();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { addToQueueByData } = usePlayer();

    const { data, isLoading } = useInfiniteQuery(
        searchQueries.searchSongsInfinite({
            enabled: debouncedQuery !== '' && query !== '',
            searchTerm: debouncedQuery,
            serverId: server?.id,
        }),
    );

    const songs = useMemo(() => data?.pages.flatMap((p) => p.songs) ?? [], [data?.pages]);

    const handleSeeAll = useCallback(() => {
        navigate(
            {
                pathname: AppRoute.LIBRARY_SONGS,
                search: createSearchParams({
                    [FILTER_KEYS.SHARED.SEARCH_TERM]: debouncedQuery || query,
                }).toString(),
            },
            { state: { navigationId: nanoid() } },
        );
        onSelectResult();
    }, [debouncedQuery, navigate, onSelectResult, query]);

    if (isLoading) {
        return (
            <>
                <SectionHeading title={t('entity.track', { count: 2 })} />
                <div className={styles.sectionSpinner}>
                    <Spinner />
                </div>
            </>
        );
    }

    if (songs.length === 0) return null;

    return (
        <>
            <SectionHeading onSeeAll={handleSeeAll} title={t('entity.track', { count: 2 })} />
            {songs.map((song, index) => (
                <MobileSearchRow
                    explicitStatus={song.explicitStatus}
                    highlightQuery={debouncedQuery}
                    imageId={song.imageId}
                    imageUrl={song.imageUrl}
                    index={index}
                    itemType={LibraryItem.SONG}
                    key={`m-song-${song.id}`}
                    onSelect={() => {
                        // Tapping a song on the mobile shell plays it
                        // immediately — same behaviour the touch path already
                        // used in SearchSongsSection.
                        if (server?.id) {
                            addToQueueByData([song], Play.NOW);
                        } else {
                            navigate(
                                generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, {
                                    albumId: song.albumId,
                                }),
                            );
                        }
                        onSelectResult();
                    }}
                    subtitle={song.artists.map((artist) => artist.name).join(', ')}
                    title={song.name}
                />
            ))}
        </>
    );
}
