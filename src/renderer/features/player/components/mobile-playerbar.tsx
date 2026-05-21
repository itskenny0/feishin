import clsx from 'clsx';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import React, { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './mobile-playerbar.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
    usePlayerSong,
    usePlayerStatus,
    usePlayerTimestamp,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import { useShowFilesystemNameForAlbums } from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Separator } from '/@/shared/components/separator/separator';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';
import { LibraryItem } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';
import { albumFolderFromSongPath } from '/@/shared/utils/album-folder-from-path';

export const MobilePlayerbar = () => {
    const { t } = useTranslation();
    const { expanded: isFullScreenPlayerExpanded } = useFullScreenPlayerStore();
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();
    const currentSong = usePlayerSong();
    const status = usePlayerStatus();
    const { mediaNext, mediaPrevious, mediaTogglePlayPause } = usePlayer();
    const title = currentSong?.name;
    const artists = currentSong?.artists;
    const isSongDefined = Boolean(currentSong?.id);
    const useFsAlbumName = useShowFilesystemNameForAlbums();
    const albumDisplayName =
        (useFsAlbumName ? albumFolderFromSongPath(currentSong?.path) : null) ||
        currentSong?.album ||
        '—';

    const handleToggleFullScreenPlayer = (e?: KeyboardEvent | MouseEvent<HTMLDivElement>) => {
        e?.stopPropagation();
        // Set active tab to player when opening fullscreen player
        setStore({ activeTab: 'player' });
        setFullScreenPlayerStore({ expanded: !isFullScreenPlayerExpanded });
    };

    const handleToggleContextMenu = (e: MouseEvent<HTMLButtonElement | HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();

        if (!currentSong) {
            return;
        }

        ContextMenuController.call({
            cmd: { items: [currentSong], type: LibraryItem.SONG },
            event: e as MouseEvent<HTMLDivElement>,
        });
    };

    const stopPropagation = (e?: MouseEvent) => e?.stopPropagation();

    // Thin Spotify-style progress strip across the bottom of the mini-
    // player. Reads the timestamp store directly so we tick every second
    // without going through the slower seek-bar machinery in the
    // fullscreen player. Stays at 0% when there's no song or no
    // duration so the strip is just an empty rail in that case.
    //
    // QueueSong.duration is in milliseconds; usePlayerTimestamp is in
    // seconds (matches what the fullscreen progress component does — it
    // does `currentSong.duration / 1000`). Convert duration to seconds
    // before the division so both sides of the ratio are in seconds.
    const timestamp = usePlayerTimestamp();
    const songDurationSec = currentSong?.duration ? currentSong.duration / 1000 : 0;
    const progressPct =
        songDurationSec > 0 ? Math.min(100, Math.max(0, (timestamp / songDurationSec) * 100)) : 0;

    return (
        <div
            className={clsx(styles.container, PlaybackSelectors.mediaPlayer)}
            style={
                {
                    ['--mobile-playerbar-progress' as string]: `${progressPct}%`,
                } as React.CSSProperties
            }
        >
            <div className={styles.contentWrapper}>
                <LayoutGroup>
                    <AnimatePresence initial={false} mode="popLayout">
                        {currentSong?.id && (
                            <div className={styles.imageWrapper}>
                                <motion.div
                                    animate={{ opacity: 1, scale: 1 }}
                                    className={styles.image}
                                    exit={{ opacity: 0 }}
                                    initial={{ opacity: 0 }}
                                    key="mobile-playerbar-image"
                                    onClick={handleToggleFullScreenPlayer}
                                    onContextMenu={handleToggleContextMenu}
                                    role="button"
                                    transition={{ duration: 0.2, ease: 'easeIn' }}
                                >
                                    <Tooltip
                                        label={t('player.toggleFullscreenPlayer')}
                                        openDelay={400}
                                    >
                                        <ItemImage
                                            className={clsx(
                                                styles.playerbarImage,
                                                PlaybackSelectors.playerCoverArt,
                                            )}
                                            enableDebounce={false}
                                            enableViewport={false}
                                            explicitStatus={currentSong.explicitStatus}
                                            fetchPriority="high"
                                            id={currentSong.imageId}
                                            itemType={LibraryItem.SONG}
                                            type="table"
                                        />
                                    </Tooltip>
                                </motion.div>
                            </div>
                        )}
                    </AnimatePresence>
                    <motion.div className={styles.metadataStack} layout="position">
                        <div className={styles.lineItem} onClick={stopPropagation}>
                            <Group align="center" gap="xs" wrap="nowrap">
                                <Text
                                    className={PlaybackSelectors.songTitle}
                                    component={Link}
                                    fw={500}
                                    isLink
                                    onClick={handleToggleFullScreenPlayer}
                                    onContextMenu={handleToggleContextMenu}
                                    overflow="hidden"
                                    size="sm"
                                    to={AppRoute.NOW_PLAYING}
                                    truncate
                                >
                                    {title || '—'}
                                </Text>
                                {isSongDefined && (
                                    <ActionIcon
                                        icon="ellipsisVertical"
                                        onClick={handleToggleContextMenu}
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
                            {artists?.map((artist, index) => (
                                <React.Fragment key={`bar-${artist.id}`}>
                                    {index > 0 && <Separator />}
                                    <Text
                                        component={artist.id ? Link : undefined}
                                        fw={500}
                                        isLink={artist.id !== ''}
                                        onClick={handleToggleFullScreenPlayer}
                                        overflow="hidden"
                                        size="xs"
                                        to={
                                            artist.id
                                                ? generatePath(
                                                      AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL,
                                                      {
                                                          albumArtistId: artist.id,
                                                      },
                                                  )
                                                : undefined
                                        }
                                    >
                                        {artist.name || '—'}
                                    </Text>
                                </React.Fragment>
                            ))}
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
                                onClick={handleToggleFullScreenPlayer}
                                overflow="hidden"
                                size="xs"
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
                    </motion.div>
                </LayoutGroup>
            </div>
            <div className={styles.controlsWrapper}>
                <PlayerButton
                    icon={<Icon fill="default" icon="mediaPrevious" size="md" />}
                    onClick={(e) => {
                        e.stopPropagation();
                        mediaPrevious();
                    }}
                    tooltip={{
                        label: t('player.previous'),
                        openDelay: 400,
                    }}
                    variant="tertiary"
                />
                <MainPlayButton
                    disabled={currentSong?.id === undefined}
                    isPaused={status === PlayerStatus.PAUSED}
                    onClick={(e) => {
                        e.stopPropagation();
                        mediaTogglePlayPause();
                    }}
                />
                <PlayerButton
                    icon={<Icon fill="default" icon="mediaNext" size="md" />}
                    onClick={(e) => {
                        e.stopPropagation();
                        mediaNext();
                    }}
                    tooltip={{
                        label: t('player.next'),
                        openDelay: 400,
                    }}
                    variant="tertiary"
                />
            </div>
            <div aria-hidden className={styles.progress}>
                <div className={styles.progressFill} />
            </div>
        </div>
    );
};
