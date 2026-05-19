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
import { RadioMetadataDisplay } from '/@/renderer/features/player/components/radio-metadata-display';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { useHotkeys } from '/@/renderer/hooks/use-hotkeys';
import { prefetchAlbumDetail, preloadRoute } from '/@/renderer/router/route-preloaders';
import { AppRoute } from '/@/renderer/router/routes';

const preloadAlbumDetail = () => preloadRoute(AppRoute.LIBRARY_ALBUMS_DETAIL);
const preloadNowPlaying = () => preloadRoute(AppRoute.NOW_PLAYING);
import {
    useAppStore,
    useAppStoreActions,
    useFullScreenPlayerStore,
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
import { LibraryItem } from '/@/shared/types/domain-types';
import { albumFolderFromSongPath } from '/@/shared/utils/album-folder-from-path';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

export const LeftControls = () => {
    const { t } = useTranslation();
    const { setSideBar } = useAppStoreActions();
    const {
        expanded: isFullScreenPlayerExpanded,
        visualizerExpanded: isFullScreenVisualizerExpanded,
    } = useFullScreenPlayerStore();
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
                                        <ItemImage
                                            className={clsx(
                                                styles.playerbarImage,
                                                PlaybackSelectors.playerCoverArt,
                                            )}
                                            enableDebounce={false}
                                            enableViewport={false}
                                            explicitStatus={currentSong?.explicitStatus}
                                            fetchPriority="high"
                                            id={currentSong?.imageId}
                                            itemType={LibraryItem.SONG}
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
                    ) : (
                        <>
                            <div className={styles.lineItem} onClick={stopPropagation}>
                                <Group align="center" gap="xs" wrap="nowrap">
                                    <Text
                                        className={PlaybackSelectors.songTitle}
                                        component={Link}
                                        fw={500}
                                        isLink
                                        onContextMenu={handleToggleContextMenu}
                                        onFocus={preloadNowPlaying}
                                        onMouseEnter={preloadNowPlaying}
                                        overflow="hidden"
                                        // Allow the title to shrink in a wrap:nowrap Group so the
                                        // year chip + ellipsis menu (flex-shrink:0) stay visible
                                        // on long titles. Without minWidth:0 a long title pushes
                                        // both off-screen on narrow playerbars.
                                        style={{ flex: '1 1 auto', minWidth: 0 }}
                                        to={AppRoute.NOW_PLAYING}
                                    >
                                        {title || '—'}
                                        {currentSong?.trackSubtitle && (
                                            <Text component="span" isMuted size="sm">
                                                {' ('}
                                                {currentSong.trackSubtitle}
                                                {')'}
                                            </Text>
                                        )}
                                    </Text>
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
                            <div
                                className={clsx(
                                    styles.lineItem,
                                    styles.secondary,
                                    PlaybackSelectors.songArtist,
                                )}
                                onClick={stopPropagation}
                            >
                                <JoinedArtists
                                    artistName={currentSong?.artistName || ''}
                                    artists={artists || []}
                                    linkProps={{
                                        ...JOINED_ARTISTS_MUTED_PROPS.linkProps,
                                        size: 'md',
                                    }}
                                    rootTextProps={{
                                        ...JOINED_ARTISTS_MUTED_PROPS.rootTextProps,
                                        size: 'md',
                                    }}
                                />
                            </div>
                            <div
                                className={clsx(
                                    styles.lineItem,
                                    styles.secondary,
                                    PlaybackSelectors.songAlbum,
                                )}
                                onClick={stopPropagation}
                            >
                                <Text
                                    component={Link}
                                    fw={500}
                                    isLink
                                    onFocus={preloadAlbumDetail}
                                    onMouseEnter={preloadAlbumDetail}
                                    onPointerDown={
                                        currentSong?.albumId
                                            ? () => prefetchAlbumDetail(currentSong.albumId!)
                                            : undefined
                                    }
                                    overflow="hidden"
                                    size="md"
                                    to={
                                        currentSong?.albumId
                                            ? generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, {
                                                  albumId: currentSong.albumId,
                                              })
                                            : ''
                                    }
                                >
                                    {albumDisplayName}
                                </Text>
                            </div>
                        </>
                    )}
                </div>
            </LayoutGroup>
        </div>
    );
};
