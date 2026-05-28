import type { PanInfo } from 'motion/react';

import clsx from 'clsx';
import {
    animate,
    AnimatePresence,
    HTMLMotionProps,
    motion,
    useMotionValue,
    Variants,
} from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import styles from './mobile-fullscreen-player.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useActiveNowPlayingItem } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { coverSwipeSignal } from '/@/renderer/features/player/utils/cover-swipe-signal';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import {
    useFullScreenPlayerStore,
    useImageRes,
    usePlayerData,
    usePlayerSong,
} from '/@/renderer/store';
import { Center } from '/@/shared/components/center/center';
import { Icon } from '/@/shared/components/icon/icon';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';
import { useSetState } from '/@/shared/hooks/use-set-state';
import { LibraryItem } from '/@/shared/types/domain-types';

const imageVariants: Variants = {
    closed: {
        opacity: 0,
        transition: {
            duration: 0.8,
            ease: 'linear',
        },
    },
    initial: {
        opacity: 0,
    },
    open: (custom) => {
        const { isOpen } = custom;
        return {
            opacity: isOpen ? 1 : 0,
            transition: {
                duration: 0.4,
                ease: 'linear',
            },
        };
    },
};

const MotionImage = motion.img;

const ImageWithPlaceholder = ({
    className,
    placeholderIcon,
    useImageAspectRatio,
    ...props
}: HTMLMotionProps<'img'> & {
    placeholder?: string;
    placeholderIcon?: 'itemAlbum' | 'radio';
    useImageAspectRatio?: boolean;
}) => {
    if (!props.src) {
        return (
            <Center
                style={{
                    background: 'var(--theme-colors-surface)',
                    borderRadius: '12px',
                    height: '100%',
                    width: '100%',
                }}
            >
                <Icon
                    color="muted"
                    icon={placeholderIcon === 'radio' ? 'radio' : 'itemAlbum'}
                    size="25%"
                />
            </Center>
        );
    }

    return (
        <MotionImage
            className={clsx(styles.albumImage, className)}
            style={{
                objectFit: useImageAspectRatio ? 'contain' : 'cover',
                width: useImageAspectRatio ? 'auto' : '100%',
            }}
            {...props}
        />
    );
};

export const MobileFullscreenPlayerAlbumArt = () => {
    const mainImageRef = useRef<HTMLImageElement | null>(null);
    const [mainImageDimensions, setMainImageDimensions] = useState({ idealSize: 1000 });

    const { fullScreenPlayer: albumArtRes } = useImageRes();
    const { useImageAspectRatio } = useFullScreenPlayerStore();
    const isRadioActive = useIsRadioActive();
    const { isPlaying: isRadioPlaying } = useRadioPlayer();
    const currentSong = usePlayerSong();
    const { nextSong, previousSong } = usePlayerData();

    // Remote (Jellyfin Connect) mode: mirror the remote device's cover. We
    // render a simple static cover for it (below) and leave the local
    // swipe/crossfade carousel untouched to avoid any local-playback regression.
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const remoteSong = useActiveNowPlayingItem();
    const remoteImageUrl = useItemImageUrl({
        id: remoteSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const isPlayingRadio = isRadioActive && isRadioPlaying;

    const currentImageUrl = useItemImageUrl({
        id: currentSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const nextImageUrl = useItemImageUrl({
        id: nextSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const previousImageUrl = useItemImageUrl({
        id: previousSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const [imageState, setImageState] = useSetState({
        bottomImage: nextImageUrl,
        current: 0,
        topImage: currentImageUrl,
    });

    const updateImageSize = useCallback(() => {
        if (mainImageRef.current) {
            const idealSize =
                albumArtRes ||
                Math.ceil((mainImageRef.current as HTMLDivElement).offsetHeight / 100) * 100;

            setMainImageDimensions({ idealSize });
        }
    }, [albumArtRes]);

    useLayoutEffect(() => {
        updateImageSize();
    }, [updateImageSize]);

    // Track previous song to detect changes
    const previousSongRef = useRef<string | undefined>(currentSong?._uniqueId);
    const imageStateRef = useRef(imageState);

    // Keep ref in sync
    useEffect(() => {
        imageStateRef.current = imageState;
    }, [imageState]);

    // Update images when song or size changes
    useEffect(() => {
        if (currentSong?._uniqueId === previousSongRef.current) {
            return;
        }

        const isTop = imageStateRef.current.current === 0;

        setImageState({
            bottomImage: isTop ? currentImageUrl : nextImageUrl,
            current: isTop ? 1 : 0,
            topImage: isTop ? nextImageUrl : currentImageUrl,
        });

        previousSongRef.current = currentSong?._uniqueId;
    }, [currentSong?._uniqueId, currentImageUrl, nextSong?._uniqueId, nextImageUrl, setImageState]);

    /*
     * Spotify-style finger-tracking carousel swipe on the cover. Same
     * pattern as the mini-player: drag stays attached to the finger,
     * velocity + offset on release decide commit-or-snap-back. The
     * BackgroundImage / overlay don't drag with it — only the cover
     * itself slides, which matches Spotify's behaviour where the cover
     * is the only swipable element.
     */
    const { mediaNext, mediaPrevious } = usePlayer();
    const coverSwipeX = useMotionValue(0);
    const isSongDefined = Boolean(currentSong?.id);

    // Track the in-flight snap-back animation so a second drag started
    // before the spring settles doesn't fight a stale animate() call.
    // Without this the motion value can end up driven by two animations
    // at once after a rapid swipe → release → swipe sequence, which is
    // what makes the cover stop following the finger until the user
    // reloads. We stop any prior controls before kicking off the next.
    const snapBackRef = useRef<null | ReturnType<typeof animate>>(null);
    const stopSnapBack = useCallback(() => {
        if (snapBackRef.current) {
            snapBackRef.current.stop();
            snapBackRef.current = null;
        }
    }, []);
    useEffect(
        () => () => {
            stopSnapBack();
            // Component is unmounting (radio mode flip, remote takeover,
            // viewport teardown) — make sure the parent's dismiss listener
            // isn't left thinking the cover still owns the gesture.
            coverSwipeSignal.end();
        },
        [stopSnapBack],
    );

    const handleCoverDragStart = useCallback(() => {
        coverSwipeSignal.start();
        // A new drag has started; cancel any snap-back from the previous
        // gesture so the finger is the sole driver of coverSwipeX.
        stopSnapBack();
    }, [stopSnapBack]);

    const handleCoverDragEnd = useCallback(
        (_event: unknown, info: PanInfo) => {
            coverSwipeSignal.end();
            const width = mainImageRef.current?.offsetWidth ?? 320;
            const commitOffset = width * 0.25;
            const flickVelocity = 500;
            const offset = info.offset.x;
            const velocity = info.velocity.x;
            const wantsNext = offset < -commitOffset || velocity < -flickVelocity;
            const wantsPrev = offset > commitOffset || velocity > flickVelocity;

            // Always cancel a stale snap-back before starting a new one.
            stopSnapBack();

            if (wantsNext && isSongDefined) {
                console.info('[cover-swipe] commit next', { offset, velocity });
                triggerHaptic('selection');
                mediaNext();
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 30,
                    stiffness: 220,
                    type: 'spring',
                    velocity,
                });
            } else if (wantsPrev && isSongDefined) {
                console.info('[cover-swipe] commit prev', { offset, velocity });
                triggerHaptic('selection');
                mediaPrevious();
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 30,
                    stiffness: 220,
                    type: 'spring',
                    velocity,
                });
            } else {
                console.info('[cover-swipe] snap back', { offset, velocity });
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 28,
                    stiffness: 360,
                    type: 'spring',
                    velocity,
                });
            }
        },
        [coverSwipeX, isSongDefined, mediaNext, mediaPrevious, stopSnapBack],
    );

    /*
     * Spotify-style swipe previews. The previous and next covers are
     * rendered offscreen to the left and right of the active cover;
     * both move with the same swipeX motion value as the main cover so
     * the user sees the adjacent track sliding in as they drag.
     *
     * - Pulling LEFT (negative x) → next cover enters from the right
     * - Pulling RIGHT (positive x) → previous cover enters from the left
     *
     * Both are hidden when the corresponding side has no song (or in
     * radio mode), so the gesture still feels clean at queue boundaries.
     */
    const nextImageSrc = !isPlayingRadio && nextSong?._uniqueId ? nextImageUrl : null;
    const previousImageSrc = !isPlayingRadio && previousSong?._uniqueId ? previousImageUrl : null;

    // Remote mode: static cover of the mirrored now-playing item. The local
    // queue's prev/next aren't the remote's, so we skip the swipe-preview
    // carousel here; the transport buttons still drive the remote device.
    if (isRemote) {
        return (
            <div className={styles.imageContainer} ref={mainImageRef}>
                <div
                    className={clsx(styles.image, {
                        [styles.imageNativeAspectRatio]: useImageAspectRatio,
                    })}
                >
                    <ImageWithPlaceholder
                        className={PlaybackSelectors.playerCoverArt}
                        draggable={false}
                        loading="eager"
                        src={remoteImageUrl || ''}
                        useImageAspectRatio={useImageAspectRatio}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className={styles.imageContainer} ref={mainImageRef}>
            {previousImageSrc && (
                <motion.div
                    aria-hidden
                    className={clsx(styles.image, styles.imagePreviousPreview, {
                        [styles.imageNativeAspectRatio]: useImageAspectRatio,
                    })}
                    style={{ x: coverSwipeX }}
                >
                    <img
                        alt=""
                        className={styles.albumImage}
                        draggable={false}
                        src={previousImageSrc}
                        style={{
                            objectFit: useImageAspectRatio ? 'contain' : 'cover',
                            width: useImageAspectRatio ? 'auto' : '100%',
                        }}
                    />
                </motion.div>
            )}
            {nextImageSrc && (
                <motion.div
                    aria-hidden
                    className={clsx(styles.image, styles.imageNextPreview, {
                        [styles.imageNativeAspectRatio]: useImageAspectRatio,
                    })}
                    style={{ x: coverSwipeX }}
                >
                    <img
                        alt=""
                        className={styles.albumImage}
                        draggable={false}
                        src={nextImageSrc}
                        style={{
                            objectFit: useImageAspectRatio ? 'contain' : 'cover',
                            width: useImageAspectRatio ? 'auto' : '100%',
                        }}
                    />
                </motion.div>
            )}
            <motion.div
                className={clsx(styles.image, {
                    [styles.imageNativeAspectRatio]: useImageAspectRatio,
                })}
                // Marker the player-face touch listener looks for so the
                // horizontal cover swipe doesn't race the dismiss drag.
                // The native touch listener on .playerState also reads
                // coverSwipeSignal.isDragging() — that's the realtime
                // version of this static attribute, set the instant
                // Motion claims the gesture in onDragStart below.
                data-cover-swipe
                drag={isSongDefined && !isPlayingRadio ? 'x' : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={1}
                dragMomentum={false}
                onDragEnd={handleCoverDragEnd}
                onDragStart={handleCoverDragStart}
                style={{ x: coverSwipeX }}
            >
                <AnimatePresence initial={false} mode="sync">
                    {isPlayingRadio ? (
                        <ImageWithPlaceholder
                            animate="open"
                            className={PlaybackSelectors.playerCoverArt}
                            custom={{ isOpen: true }}
                            draggable={false}
                            exit="closed"
                            initial="closed"
                            key="radio"
                            loading="eager"
                            placeholder="var(--theme-colors-foreground-muted)"
                            placeholderIcon="radio"
                            src=""
                            useImageAspectRatio={useImageAspectRatio}
                            variants={imageVariants}
                        />
                    ) : (
                        <>
                            {imageState.current === 0 && (
                                <ImageWithPlaceholder
                                    animate="open"
                                    className={PlaybackSelectors.playerCoverArt}
                                    custom={{ isOpen: imageState.current === 0 }}
                                    draggable={false}
                                    exit="closed"
                                    initial="closed"
                                    key={`top-${currentSong?._uniqueId || 'none'}`}
                                    loading="eager"
                                    placeholder="var(--theme-colors-foreground-muted)"
                                    src={imageState.topImage || ''}
                                    useImageAspectRatio={useImageAspectRatio}
                                    variants={imageVariants}
                                />
                            )}

                            {imageState.current === 1 && (
                                <ImageWithPlaceholder
                                    animate="open"
                                    className={PlaybackSelectors.playerCoverArt}
                                    custom={{ isOpen: imageState.current === 1 }}
                                    draggable={false}
                                    exit="closed"
                                    initial="closed"
                                    key={`bottom-${currentSong?._uniqueId || 'none'}`}
                                    loading="eager"
                                    placeholder="var(--theme-colors-foreground-muted)"
                                    src={imageState.bottomImage || ''}
                                    useImageAspectRatio={useImageAspectRatio}
                                    variants={imageVariants}
                                />
                            )}
                        </>
                    )}
                </AnimatePresence>
            </motion.div>
        </div>
    );
};
