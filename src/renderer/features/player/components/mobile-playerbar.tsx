import clsx from 'clsx';
import { AnimatePresence, LayoutGroup, motion, useMotionValue } from 'motion/react';
import React, { memo, MouseEvent, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './mobile-playerbar.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { useHorizontalSwipe } from '/@/renderer/hooks/use-horizontal-swipe';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
    usePlayerSong,
    usePlayerStatus,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import { useShowFilesystemNameForAlbums } from '/@/renderer/store/settings.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
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

    // Horizontal swipe on the metadata/cover area skips next/previous,
    // mirroring Spotify's mini-player behaviour. Drag-left advances,
    // drag-right goes back. Only fires on touch (mouse keeps tap-to-
    // expand) and only past 60px so accidental drift on a tap doesn't
    // fire. The buttons (prev/play/next) sit outside this wrapper so
    // their clicks are unaffected.
    //
    // We also stream the live x-delta into a Motion value so the
    // cover + metadata translate WITH the finger as it drags —
    // exactly how Spotify's mini-player feels. Once the threshold is
    // crossed (or the user lifts), the handler sends dx=0 which
    // Motion's spring animates back to rest (or onto the next song,
    // whichever the threshold crossing fired). The trans-X value is
    // applied via `style={{ x: swipeX }}` on the content wrapper.
    const swipeX = useMotionValue(0);
    const handleSwipeMove = useCallback(
        (dx: number) => {
            // Light rubber-banding above 80px so the bar visibly resists
            // very long drags — drags that mean "I changed my mind"
            // shouldn't visually overshoot off-screen.
            const cappedDx =
                Math.abs(dx) > 80 ? Math.sign(dx) * (80 + (Math.abs(dx) - 80) * 0.35) : dx;
            swipeX.set(cappedDx);
        },
        [swipeX],
    );
    const swipeHandlers = useHorizontalSwipe({
        disabled: !isSongDefined,
        onSwipeLeft: mediaNext,
        onSwipeMove: handleSwipeMove,
        onSwipeRight: mediaPrevious,
    });

    return (
        <div className={clsx(styles.container, PlaybackSelectors.mediaPlayer)}>
            <motion.div
                {...swipeHandlers}
                className={styles.contentWrapper}
                style={{ x: swipeX }}
                transition={{ damping: 28, mass: 0.6, stiffness: 380, type: 'spring' }}
            >
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
                                    fw={700}
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
                        {/*
                         * Spotify pattern: tapping the artist or album line
                         * in the MINI-player surfaces the fullscreen player
                         * — the same affordance as tapping the cover. The
                         * artist/album detail pages are reachable via the
                         * fullscreen player metadata (which IS linked) or
                         * via the long-press context menu. Removing the
                         * inline navigation here makes the whole content
                         * row feel like one cohesive tap target.
                         */}
                        <div
                            className={clsx(
                                styles.lineItem,
                                styles.secondary,
                                PlaybackSelectors.songArtist,
                            )}
                            onClick={handleToggleFullScreenPlayer}
                        >
                            {artists?.map((artist, index) => (
                                <React.Fragment key={`bar-${artist.id}`}>
                                    {index > 0 && <Separator />}
                                    <Text fw={500} overflow="hidden" size="xs">
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
                            onClick={handleToggleFullScreenPlayer}
                        >
                            <Text fw={500} overflow="hidden" size="xs">
                                {albumDisplayName}
                            </Text>
                        </div>
                    </motion.div>
                </LayoutGroup>
            </motion.div>
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
            <MiniPlayerProgressStrip durationMs={currentSong?.duration ?? 0} />
        </div>
    );
};

/**
 * Bottom progress strip on the mini-player.
 *
 * Lives in its own memoised component so the timestamp subscription
 * doesn't force the rest of the mini-player (image, metadata, controls)
 * to re-render every second. Receives the song duration as a prop so it
 * doesn't need its own currentSong subscription.
 *
 * QueueSong.duration is in milliseconds; usePlayerTimestamp is in
 * seconds (matches what the fullscreen progress component does — it
 * does `currentSong.duration / 1000`). Convert duration to seconds
 * before the division so both sides of the ratio are in seconds.
 */
const MiniPlayerProgressStrip = memo(({ durationMs }: { durationMs: number }) => {
    const timestamp = useTimestampStoreBase((state) => state.timestamp);
    const songDurationSec = durationMs > 0 ? durationMs / 1000 : 0;
    const progressPct =
        songDurationSec > 0 ? Math.min(100, Math.max(0, (timestamp / songDurationSec) * 100)) : 0;

    return (
        <div
            aria-hidden
            className={styles.progress}
            style={
                {
                    ['--mobile-playerbar-progress' as string]: `${progressPct}%`,
                } as React.CSSProperties
            }
        >
            <div className={styles.progressFill} />
        </div>
    );
});

MiniPlayerProgressStrip.displayName = 'MiniPlayerProgressStrip';
