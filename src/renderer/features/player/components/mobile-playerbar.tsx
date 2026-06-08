import type { PanInfo } from 'motion/react';

import clsx from 'clsx';
import { animate, AnimatePresence, LayoutGroup, motion, useMotionValue } from 'motion/react';
import React, { memo, MouseEvent, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './mobile-playerbar.module.css';

import { ItemImage } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { MobileDevicePickerButton } from '/@/renderer/features/jellyfin-remote-target';
import {
    useActiveIsPaused,
    useActiveNowPlayingItem,
    useRemoteInterpolatedPositionMs,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { MainPlayButton, PlayerButton } from '/@/renderer/features/player/components/player-button';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { decideCoverSwipeCommit } from '/@/renderer/features/player/utils/cover-swipe-signal';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { TrackmapCanvas } from '/@/renderer/features/trackmap';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import { AppRoute } from '/@/renderer/router/routes';
import {
    useFullScreenPlayerExpanded,
    useFullScreenPlayerStoreActions,
    usePlayerData,
    useSetFullScreenPlayerStore,
} from '/@/renderer/store';
import {
    useMobilePlayerbarShowNavButtons,
    useShowFilesystemNameForAlbums,
    useTrackmapEnabled,
} from '/@/renderer/store/settings.store';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { Icon } from '/@/shared/components/icon/icon';
import { Separator } from '/@/shared/components/separator/separator';
import { Text } from '/@/shared/components/text/text';
import { Tooltip } from '/@/shared/components/tooltip/tooltip';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';
import { LibraryItem } from '/@/shared/types/domain-types';
import { albumFolderFromSongPath } from '/@/shared/utils/album-folder-from-path';

export const MobilePlayerbar = () => {
    const { t } = useTranslation();
    const isFullScreenPlayerExpanded = useFullScreenPlayerExpanded();
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();
    // Active source: mirrors the remote device's now-playing/state when a
    // Jellyfin Connect target is selected, else the local player (no-op locally).
    const currentSong = useActiveNowPlayingItem();
    const isPaused = useActiveIsPaused();
    const canPrevious = useTransportEnabled('PreviousTrack');
    const canNext = useTransportEnabled('NextTrack');
    const canPlayPause = useTransportEnabled('PlayPause');
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    // Queue boundary awareness so a swipe at end-of-queue (repeat=NONE)
    // springs back instead of triggering a mediaNext() that the store
    // would no-op while the cover visibly slides off.
    const { nextSong, previousSong } = usePlayerData();
    const hasNext = Boolean(nextSong?._uniqueId);
    const hasPrevious = Boolean(previousSong?._uniqueId);
    const { mediaNext, mediaPrevious, mediaTogglePlayPause } = usePlayer();
    const title = currentSong?.name;
    const artists = currentSong?.artists;
    const isSongDefined = Boolean(currentSong?.id);
    const useFsAlbumName = useShowFilesystemNameForAlbums();
    const showNavButtons = useMobilePlayerbarShowNavButtons();
    const trackmapEnabled = useTrackmapEnabled();
    const albumDisplayName =
        (useFsAlbumName ? albumFolderFromSongPath(currentSong?.path) : null) ||
        currentSong?.album ||
        '—';

    const handleToggleFullScreenPlayer = useCallback(
        (e?: KeyboardEvent | MouseEvent<HTMLDivElement>) => {
            e?.stopPropagation();
            // Set active tab to player when opening fullscreen player
            setStore({ activeTab: 'player' });
            setFullScreenPlayerStore({ expanded: !isFullScreenPlayerExpanded });
        },
        [isFullScreenPlayerExpanded, setFullScreenPlayerStore, setStore],
    );

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

    /*
     * Spotify-style finger-tracking carousel swipe.
     *
     * Uses Motion's native drag="x" so the content row stays attached
     * to the finger the entire way (no threshold-and-jump). On
     * release, a combined velocity + offset rule decides whether the
     * gesture commits to next/previous (fast flick OR drag past 25%
     * of container width) or springs back to rest. Inertia is
     * preserved across the commit by passing the release-velocity into
     * the snap-back animation, so a quick flick reads as one
     * continuous gesture instead of two separate ones.
     */
    const containerRef = useRef<HTMLDivElement>(null);
    const swipeX = useMotionValue(0);
    const handleDragEnd = useCallback(
        (_event: unknown, info: PanInfo) => {
            const width = containerRef.current?.offsetWidth ?? 320;
            const offset = info.offset.x;
            const velocity = info.velocity.x;

            // Share the fullscreen player's commit decision so the mini
            // player honours queue boundaries (no next/prev song =>
            // snap back instead of firing a no-op skip that visibly
            // slides the cover off and back).
            const decision = decideCoverSwipeCommit({
                coverWidth: width,
                hasNext,
                hasPrevious,
                // The mini-player is hidden entirely during radio
                // playback, so there's no realistic "radio active"
                // state to handle here — fixed to false.
                isRadioActive: false,
                isSongDefined,
                offsetX: offset,
                velocityX: velocity,
            });

            if (decision === 'next') {
                triggerHaptic('selection');
                mediaNext();
                // Continue the motion with the release velocity for a
                // beat so the gesture feels like a single throw rather
                // than a jolt-and-snap. The current-song slot
                // visually "swipes off" before resetting to 0 (the
                // new song now occupies the slot).
                animate(swipeX, 0, {
                    damping: 30,
                    stiffness: 220,
                    type: 'spring',
                    velocity,
                });
            } else if (decision === 'previous') {
                triggerHaptic('selection');
                mediaPrevious();
                animate(swipeX, 0, {
                    damping: 30,
                    stiffness: 220,
                    type: 'spring',
                    velocity,
                });
            } else {
                // Not enough drag/velocity or at queue boundary — spring
                // back to rest. Carry the release velocity so the
                // bounce feels natural.
                animate(swipeX, 0, {
                    damping: 28,
                    stiffness: 360,
                    type: 'spring',
                    velocity,
                });
            }
        },
        [hasNext, hasPrevious, isSongDefined, mediaNext, mediaPrevious, swipeX],
    );

    /*
     * Swipe-up to open the fullscreen player. The mini-player's
     * horizontal drag is on the inner motion.div (.contentWrapper)
     * which only activates on x-axis movement, so a finger that
     * starts moving UP first never triggers the carousel — the
     * gesture bubbles to the container where we capture it here.
     *
     * Threshold: 50px upward drag OR a quick flick (velocity below
     * -500 px/s). Tap-and-drift won't fire (need ≥50px). Drag-down
     * is intentionally ignored; the mini-player is already pinned
     * to the bottom of the screen so there's nowhere to go.
     */
    const upwardStartRef = useRef<null | { time: number; x: number; y: number }>(null);
    const handleContainerPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        upwardStartRef.current = {
            time: performance.now(),
            x: event.clientX,
            y: event.clientY,
        };
    }, []);
    const handleContainerPointerMove = useCallback(
        (event: React.PointerEvent<HTMLDivElement>) => {
            const start = upwardStartRef.current;
            if (!start) return;
            const dy = event.clientY - start.y;
            const dx = Math.abs(event.clientX - start.x);
            // Only commit on clearly vertical-up motion. If the user is
            // moving more horizontally, the inner drag handler owns this
            // gesture — bail so we don't double-fire.
            if (Math.abs(dy) < dx * 0.8) {
                upwardStartRef.current = null;
                return;
            }
            if (dy < -50) {
                upwardStartRef.current = null;
                triggerHaptic('selection');
                handleToggleFullScreenPlayer();
            }
        },
        [handleToggleFullScreenPlayer],
    );
    const handleContainerPointerUp = useCallback(() => {
        const start = upwardStartRef.current;
        if (!start) return;
        // Velocity-based flick: if the last contact was very recent and
        // covered some upward distance, treat as a flick even if the
        // 50px move threshold didn't quite hit.
        upwardStartRef.current = null;
    }, []);

    return (
        <div
            className={clsx(styles.container, PlaybackSelectors.mediaPlayer)}
            onPointerDown={handleContainerPointerDown}
            onPointerMove={handleContainerPointerMove}
            onPointerUp={handleContainerPointerUp}
            ref={containerRef}
        >
            {trackmapEnabled && isSongDefined && (
                <div aria-hidden className={styles.trackmapBackdrop}>
                    <ComponentErrorBoundary>
                        {/* Mini-bar renders the trackmap standalone, edge-to-edge,
                            with no seek slider behind it — so disable the slider
                            geometry inset that would otherwise make the playhead
                            lead the true progress by ~12px. */}
                        <TrackmapCanvas sliderInsetPx={0} />
                    </ComponentErrorBoundary>
                </div>
            )}
            <motion.div
                className={styles.contentWrapper}
                drag={isSongDefined ? 'x' : false}
                dragConstraints={{ left: 0, right: 0 }}
                /*
                 * dragElastic=1 lets the user drag freely beyond the
                 * 0,0 constraints — Motion handles the visual stretch
                 * itself, so we don't have to apply rubber-banding in
                 * JS. The carousel feels like a Spotify list under
                 * the finger: light resistance, no hard wall.
                 */
                dragElastic={1}
                /*
                 * dragMomentum=false because we're handling the
                 * commit ourselves in onDragEnd. Without this, Motion
                 * would coast the wrapper offscreen on a flick before
                 * we got to fire mediaNext, leaving the bar visibly
                 * empty for a frame.
                 */
                dragMomentum={false}
                onDragEnd={handleDragEnd}
                style={{ x: swipeX }}
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
                <MobileDevicePickerButton iconSize="md" variant="subtle" />
                {showNavButtons && (
                    <PlayerButton
                        disabled={!canPrevious}
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
                )}
                <MainPlayButton
                    disabled={currentSong?.id === undefined || !canPlayPause}
                    isPaused={isPaused}
                    onClick={(e) => {
                        e.stopPropagation();
                        mediaTogglePlayPause();
                    }}
                />
                {showNavButtons && (
                    <PlayerButton
                        disabled={!canNext}
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
                )}
            </div>
            <MiniPlayerProgressStrip durationMs={currentSong?.duration ?? 0} isRemote={isRemote} />
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
const MiniPlayerProgressStrip = memo(
    ({ durationMs, isRemote }: { durationMs: number; isRemote: boolean }) => {
        const localTimestamp = useTimestampStoreBase((state) => state.timestamp);
        const remotePositionMs = useRemoteInterpolatedPositionMs();
        const timestamp = isRemote ? remotePositionMs / 1000 : localTimestamp;
        const songDurationSec = durationMs > 0 ? durationMs / 1000 : 0;
        const progressPct =
            songDurationSec > 0
                ? Math.min(100, Math.max(0, (timestamp / songDurationSec) * 100))
                : 0;

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
    },
);

MiniPlayerProgressStrip.displayName = 'MiniPlayerProgressStrip';
