import clsx from 'clsx';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';
import { shallow } from 'zustand/shallow';

import styles from './left-controls.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import {
    JOINED_ARTISTS_MUTED_PROPS,
    JoinedArtists,
} from '/@/renderer/features/albums/components/joined-artists';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { useActiveNowPlayingItem } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { PlayingIndicator } from '/@/renderer/features/player/components/playing-indicator';
import { RadioMetadataDisplay } from '/@/renderer/features/player/components/radio-metadata-display';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { useTruncationDetection } from '/@/renderer/features/shared/components/truncated-text';
import { useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { prefetchAlbumDetail, preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';

const preloadAlbumDetail = () => preloadRoute(AppRoute.LIBRARY_ALBUMS_DETAIL);
const preloadNowPlaying = () => preloadRoute(AppRoute.NOW_PLAYING);
import {
    useAppStore,
    useAppStoreActions,
    useFullScreenPlayerExpanded,
    useFullScreenPlayerVisualizerExpanded,
    useHotkeySettings,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import {
    useShowFilesystemNameForAlbums,
    useShowPlaybarYearChip,
} from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Center } from '/@/shared/components/center/center';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { albumFolderFromSongPath } from '/@/shared/utils/album-folder-from-path';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

export const LeftControls = () => {
    const { t } = useTranslation();
    const { setSideBar } = useAppStoreActions();
    const isFullScreenPlayerExpanded = useFullScreenPlayerExpanded();
    const isFullScreenVisualizerExpanded = useFullScreenPlayerVisualizerExpanded();
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();

    const { collapsed, image } = useAppStore(
        (state) => ({
            collapsed: state.sidebar.collapsed,
            image: state.sidebar.image,
        }),
        shallow,
    );

    const currentSong = useActiveNowPlayingItem();
    const isRadioActive = useIsRadioActive();
    const { currentStationArt } = useRadioPlayer();
    const { bindings } = useHotkeySettings();
    const useFsAlbumName = useShowFilesystemNameForAlbums();
    const showYearChip = useShowPlaybarYearChip();
    const albumDisplayName =
        (useFsAlbumName ? albumFolderFromSongPath(currentSong?.path) : null) ||
        currentSong?.album ||
        '—';

    const isRadioMode = isRadioActive;
    const hasRadioStationImage = Boolean(currentStationArt?.imageId || currentStationArt?.imageUrl);
    const hideImage = image && !collapsed;
    const isSongDefined = Boolean(currentSong?.id) && !isRadioMode;
    const title = currentSong?.name;
    const artists = currentSong?.artists;

    const handleToggleFullScreenPlayer = (e?: KeyboardEvent | MouseEvent<HTMLDivElement>) => {
        // don't toggle if right click
        if (e && 'button' in e && e.button === 2) {
            return;
        }

        e?.stopPropagation();

        const shouldClose = isFullScreenPlayerExpanded || isFullScreenVisualizerExpanded;

        if (shouldClose) {
            setFullScreenPlayerStore({ expanded: false, visualizerExpanded: false });
        } else {
            setFullScreenPlayerStore({ expanded: true });
        }
    };

    const handleToggleSidebarImage = (e?: MouseEvent<HTMLButtonElement>) => {
        e?.stopPropagation();
        setSideBar({ image: true });
    };

    const handleToggleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        if (!currentSong) {
            return;
        }

        ContextMenuController.call({
            cmd: { items: [currentSong], type: LibraryItem.SONG },
            event: e,
        });
    };

    const stopPropagation = (e?: MouseEvent) => e?.stopPropagation();

    useHotkeys([
        [
            bindings.toggleFullscreenPlayer.allowGlobal
                ? ''
                : bindings.toggleFullscreenPlayer.hotkey,
            handleToggleFullScreenPlayer,
        ],
    ]);

    return (
        <div className={styles.leftControlsContainer}>
            <LayoutGroup>
                <AnimatePresence initial={false} mode="popLayout">
                    {!hideImage && (
                        <div className={styles.imageWrapper}>
                            <motion.div
                                animate={{ opacity: 1, scale: 1, x: 0 }}
                                className={styles.image}
                                exit={{ opacity: 0, x: -50 }}
                                initial={{ opacity: 0, x: -50 }}
                                key="playerbar-image"
                                onClick={handleToggleFullScreenPlayer}
                                onContextMenu={handleToggleContextMenu}
                                role="button"
                                transition={{ duration: 0.2, ease: 'easeIn' }}
                            >
                                <Tooltip label={t('player.toggleFullscreenPlayer')} openDelay={400}>
                                    {isRadioMode && hasRadioStationImage ? (
                                        <ItemImage
                                            className={clsx(
                                                styles.playerbarImage,
                                                PlaybackSelectors.playerCoverArt,
                                            )}
                                            enableDebounce={false}
                                            enableViewport={false}
                                            fetchPriority="high"
                                            id={currentStationArt?.imageId ?? undefined}
                                            itemType={LibraryItem.RADIO_STATION}
                                            serverId={currentStationArt?.serverId}
                                            src={currentStationArt?.imageUrl ?? ''}
                                            type="table"
                                        />
                                    ) : isRadioMode ? (
                                        <Center
                                            className={clsx(
                                                styles.playerbarImage,
                                                styles.radioImage,
                                            )}
                                        >
                                            <Icon color="muted" icon="radio" size="40%" />
                                        </Center>
                                    ) : (
                                        // Key off the song id so the image element
                                        // remounts when the playing song changes and
                                        // the .animated fade-in keyframe replays. Without
                                        // this the <img> just swaps its src and snaps to
                                        // the new cover with no transition. Honors
                                        // prefers-reduced-motion via the underlying CSS.
                                        <ItemImage
                                            className={clsx(
                                                styles.playerbarImage,
                                                PlaybackSelectors.playerCoverArt,
                                            )}
                                            enableDebounce={false}
                                            enableViewport={false}
                                            explicitStatus={currentSong?.explicitStatus}
                                            fetchPriority="high"
                                            // Album cover (cached by albumId); the
                                            // song's own imageId isn't swept.
                                            id={currentSong?.albumId ?? currentSong?.imageId}
                                            itemType={LibraryItem.SONG}
                                            key={currentSong?.id ?? 'playerbar-empty'}
                                            serverId={currentSong?._serverId}
                                            type="table"
                                        />
                                    )}
                                </Tooltip>
                                {!collapsed && (
                                    <ActionIcon
                                        icon="arrowUpS"
                                        iconProps={{ size: 'xl' }}
                                        onClick={handleToggleSidebarImage}
                                        opacity={0.8}
                                        radius="md"
                                        size="xs"
                                        style={{
                                            cursor: 'default',
                                            position: 'absolute',
                                            right: 2,
                                            top: 2,
                                        }}
                                        tooltip={{
                                            label: t('common.expand'),
                                            openDelay: 400,
                                        }}
                                    />
                                )}
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>
                {/* Plain div, not motion.div with layout='position'. The
                    layout animation re-ran on every song change because the
                    image's exit animation briefly removes the sibling,
                    nudging this stack's position. Result was the title /
                    artist / album text jiggling every track. With layout
                    removed the metadata stays still and the cover swap
                    still animates. */}
                <div className={styles.metadataStack}>
                    {isRadioMode ? (
                        <RadioMetadataDisplay
                            onStopPropagation={stopPropagation}
                            onToggleContextMenu={handleToggleContextMenu}
                        />
                    ) : !isSongDefined ? (
                        // Idle state: nothing in the queue. Without this the
                        // metadata stack rendered three empty/"—" rows which
                        // read as a broken layout. A single muted hint with
                        // an icon makes the empty slot read as intentional.
                        <Group
                            align="center"
                            className={styles.idleMetadata}
                            gap="xs"
                            onClick={stopPropagation}
                            wrap="nowrap"
                        >
                            <Icon color="muted" icon="emptySongImage" size="lg" />
                            <Text isMuted size="sm">
                                {t('player.noSongPlaying')}
                            </Text>
                        </Group>
                    ) : (
                        <>
                            <div className={styles.lineItem} onClick={stopPropagation}>
                                <Group align="center" gap="xs" wrap="nowrap">
                                    <PlayingIndicator />
                                    <PlayerbarTitle
                                        currentSong={currentSong}
                                        onContextMenu={handleToggleContextMenu}
                                        title={title}
                                    />
                                    {showYearChip &&
                                        isPlausibleReleaseYear(currentSong?.releaseYear) && (
                                            <span
                                                className={styles.yearChip}
                                                title={String(currentSong?.releaseYear)}
                                            >
                                                {currentSong?.releaseYear}
                                            </span>
                                        )}
                                    {isSongDefined && (
                                        <ActionIcon
                                            aria-label={t('common.more')}
                                            icon="ellipsisVertical"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                if (currentSong) {
                                                    ContextMenuController.call({
                                                        cmd: {
                                                            items: [currentSong],
                                                            type: LibraryItem.SONG,
                                                        },
                                                        event: e,
                                                    });
                                                }
                                            }}
                                            size="xs"
                                            styles={{
                                                root: {
                                                    '--ai-size-xs': '1.15rem',
                                                },
                                            }}
                                            variant="subtle"
                                        />
                                    )}
                                </Group>
                            </div>
                            <PlayerbarArtistLine
                                artistName={currentSong?.artistName || ''}
                                artists={artists || []}
                                stopPropagation={stopPropagation}
                            />
                            <PlayerbarAlbumLine
                                albumDisplayName={albumDisplayName}
                                albumId={currentSong?.albumId}
                                stopPropagation={stopPropagation}
                            />
                        </>
                    )}
                </div>
            </LayoutGroup>
        </div>
    );
};

// Title line of the playerbar metadata stack. The title can include a
// parenthesised track subtitle, which is rendered inline in a muted
// span. When the visible portion overflows and gets ellipsised, a
// tooltip shows the full title (plus subtitle if present) so the user
// can still read long names without expanding the player.
interface PlayerbarTitleProps {
    currentSong: null | Song;
    onContextMenu: (e: MouseEvent<HTMLDivElement>) => void;
    title: string | undefined;
}

const PlayerbarTitle = ({ currentSong, onContextMenu, title }: PlayerbarTitleProps) => {
    const displayTitle = title || '—';
    const subtitle = currentSong?.trackSubtitle;
    const fullLabel = subtitle ? `${displayTitle} (${subtitle})` : displayTitle;

    const { isTruncated, ref } = useTruncationDetection<HTMLSpanElement>([fullLabel]);

    // The Text+Link is the actual anchored element. The detection
    // <span> sits inside it and measures the rendered text — both have
    // overflow:hidden so the inner span's scrollWidth reflects the
    // pre-clip width of the title text.
    const titleNode = (
        <Text
            className={PlaybackSelectors.songTitle}
            component={Link}
            fw={500}
            isLink
            onContextMenu={onContextMenu}
            onFocus={preloadNowPlaying}
            onMouseEnter={preloadNowPlaying}
            overflow="hidden"
            size="sm"
            style={{ flex: '1 1 auto', minWidth: 0 }}
            to={AppRoute.NOW_PLAYING}
        >
            <span
                ref={ref}
                style={{
                    display: 'block',
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                }}
            >
                {displayTitle}
                {subtitle && (
                    <Text component="span" isMuted size="sm">
                        {' ('}
                        {subtitle}
                        {')'}
                    </Text>
                )}
            </span>
        </Text>
    );

    if (!isTruncated) return titleNode;

    return (
        <Tooltip label={fullLabel} openDelay={500} position="top" withinPortal>
            {titleNode}
        </Tooltip>
    );
};

// Artist line. JoinedArtists renders multiple inline Text spans
// (matching album-artist names against the artistName string), so
// truncation lives on the surrounding line container. The plain
// artistName string is the tooltip label — that's the full text
// users want to read on hover.
interface PlayerbarArtistLineProps {
    artistName: string;
    artists: Song['artists'];
    stopPropagation: (e?: MouseEvent) => void;
}

const PlayerbarArtistLine = ({
    artistName,
    artists,
    stopPropagation,
}: PlayerbarArtistLineProps) => {
    const { isTruncated, ref } = useTruncationDetection<HTMLDivElement>([artistName]);

    const node = (
        <div
            className={clsx(styles.lineItem, styles.secondary, PlaybackSelectors.songArtist)}
            onClick={stopPropagation}
            ref={ref}
        >
            <JoinedArtists
                artistName={artistName}
                artists={artists || []}
                linkProps={{
                    ...JOINED_ARTISTS_MUTED_PROPS.linkProps,
                    size: 'sm',
                }}
                rootTextProps={{
                    ...JOINED_ARTISTS_MUTED_PROPS.rootTextProps,
                    size: 'sm',
                }}
            />
        </div>
    );

    if (!isTruncated || !artistName) return node;

    return (
        <Tooltip label={artistName} openDelay={500} position="top" withinPortal>
            {node}
        </Tooltip>
    );
};

// Album line. Plain Text + Link with the same ellipsis recipe as the
// other two. Tooltip only fires when the visible name is clipped.
interface PlayerbarAlbumLineProps {
    albumDisplayName: string;
    albumId: string | undefined;
    stopPropagation: (e?: MouseEvent) => void;
}

const PlayerbarAlbumLine = ({
    albumDisplayName,
    albumId,
    stopPropagation,
}: PlayerbarAlbumLineProps) => {
    const { isTruncated, ref } = useTruncationDetection<HTMLSpanElement>([albumDisplayName]);

    const node = (
        <div
            className={clsx(styles.lineItem, styles.secondary, PlaybackSelectors.songAlbum)}
            onClick={stopPropagation}
        >
            <Text
                component={Link}
                fw={500}
                isLink
                onFocus={preloadAlbumDetail}
                onMouseEnter={preloadAlbumDetail}
                onPointerDown={albumId ? () => prefetchAlbumDetail(albumId) : undefined}
                overflow="hidden"
                size="sm"
                to={albumId ? generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId }) : ''}
            >
                <span
                    ref={ref}
                    style={{
                        display: 'block',
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                    }}
                >
                    {albumDisplayName}
                </span>
            </Text>
        </div>
    );

    if (!isTruncated || !albumDisplayName || albumDisplayName === '—') return node;

    return (
        <Tooltip label={albumDisplayName} openDelay={500} position="top" withinPortal>
            {node}
        </Tooltip>
    );
};
