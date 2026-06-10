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

import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useActiveNowPlayingItem } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import {
    coverGestureArbiter,
    decideCoverSwipeCommit,
} from '/@/renderer/features/player/utils/cover-swipe-signal';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import {
    useFullScreenPlayerUseImageAspectRatio,
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
    // Leaf selector — album-art is the heaviest mount in the mobile player;
    // re-rendering it on every fullscreen-store change (tab swap, opacity
    // slider drag, dynamic-background toggle) tore down the crossfade
    // image stack unnecessarily.
    const useImageAspectRatio = useFullScreenPlayerUseImageAspectRatio();
    const isRadioActive = useIsRadioActive();
    const { isPlaying: isRadioPlaying } = useRadioPlayer();
    const currentSong = usePlayerSong();
    const { nextSong, previousSong } = usePlayerData();

    // Remote (Jellyfin Connect) mode: mirror the remote device's cover. We
    // render a simple static cover for it (below) and leave the local
    // swipe/crossfade carousel untouched to avoid any local-playback regression.
    const isRemote = useRemoteTargetStore((s) => s.targetDeviceId !== null);
    const remoteSong = useActiveNowPlayingItem();
    const remoteImageUrl = useCachedItemImageUrl({
        id: remoteSong?.imageId || undefined,
        // The MQTT-lane mirror builds a stub Song that carries `imageUrl` (from
        // the wire `track.art`) but no `imageId`, so resolving by id alone
        // returns nothing → placeholder disc. Forward imageUrl too (same pattern
        // MobilePlayerContainer uses); the resolver short-circuits on it.
        imageUrl: remoteSong?.imageUrl,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const isPlayingRadio = isRadioActive && isRadioPlaying;

    const currentImageUrl = useCachedItemImageUrl({
        id: currentSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const nextImageUrl = useCachedItemImageUrl({
        id: nextSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        size: mainImageDimensions.idealSize,
        type: 'fullScreenPlayer',
    });

    const previousImageUrl = useCachedItemImageUrl({
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
    const coverRef = useRef<HTMLDivElement | null>(null);

    /*
     * Queue-boundary gating. nextSong / previousSong reflect repeat +
     * shuffle, so at end-of-queue with repeat=NONE nextSong is undefined
     * — and the peek cover for that side is already hidden. We mirror
     * that here so a commit-magnitude swipe at the boundary snaps back
     * instead of firing a mediaNext() that the store would no-op,
     * which would visibly slide the cover off and back with no
     * track change.
     */
    const hasNext = Boolean(nextSong?._uniqueId);
    const hasPrevious = Boolean(previousSong?._uniqueId);

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
            // viewport teardown) — make sure the player face's dismiss
            // listener isn't left thinking the cover still owns the gesture.
            coverGestureArbiter.release();
        },
        [stopSnapBack],
    );

    /*
     * Latest gesture inputs, read synchronously inside the native touch
     * listener. The listener is registered once (per remote-mode flip) so
     * it must not close over stale render values — mirrors the pattern the
     * player face uses for its dismiss handler.
     */
    const coverStateRef = useRef({
        hasNext,
        hasPrevious,
        isRadioActive,
        isSongDefined,
        mediaNext,
        mediaPrevious,
    });
    coverStateRef.current = {
        hasNext,
        hasPrevious,
        isRadioActive,
        isSongDefined,
        mediaNext,
        mediaPrevious,
    };

    /*
     * Cover swipe carousel — a synchronous native touch listener instead of
     * Framer Motion's `drag="x"`. Motion decides "this is a drag" only after
     * its own movement threshold, asynchronously, which lands *after* the
     * player face's synchronous touchmove had already claimed the vertical
     * dismiss — so both gestures drove their motion values at once and the
     * cover fought the dismiss. A native listener decides the axis on the
     * same event the face would, and because this element is an inner node it
     * runs first in DOM bubble order, so `coverGestureArbiter` resolves every
     * move deterministically.
     */
    useEffect(() => {
        // Remote mode renders a static cover (no carousel) and never attaches
        // this ref; re-running on `isRemote` lets us (re)attach when the user
        // leaves remote mode.
        if (isRemote) return undefined;
        const el = coverRef.current;
        if (!el) return undefined;

        // The active touch identifier — so a second finger landing mid-swipe
        // can't hijack or reset tracking.
        let activeId: null | number = null;
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastT = 0;
        let velocityX = 0;
        // 'none' = undecided, 'x' = we own the horizontal swipe, 'declined' =
        // this touch belongs to the face (dismiss / native scroll).
        let axis: 'declined' | 'none' | 'x' = 'none';

        const findTouch = (e: TouchEvent): null | Touch => {
            if (activeId === null) return null;
            for (let i = 0; i < e.changedTouches.length; i += 1) {
                const t = e.changedTouches[i];
                if (t.identifier === activeId) return t;
            }
            return null;
        };

        const onTouchStart = (e: TouchEvent) => {
            // Only the first finger begins a gesture; a second finger must not
            // reset the arbiter or re-seed tracking mid-swipe. On a fresh
            // single finger we also clear any local gesture state, so a dead
            // gesture whose touchend/touchcancel were never delivered (a known
            // WebView/iOS quirk when the OS steals a touch) can't leave a stale
            // activeId/axis that makes the next touch track from a stale origin.
            if (e.touches.length === 1) {
                coverGestureArbiter.release();
                activeId = null;
                axis = 'none';
            }
            if (activeId !== null) return;
            const touch = e.changedTouches[0];
            if (!touch) return;
            activeId = touch.identifier;
            startX = touch.clientX;
            startY = touch.clientY;
            lastX = startX;
            lastT = performance.now();
            velocityX = 0;
            axis = 'none';
            stopSnapBack();
        };

        const onTouchMove = (e: TouchEvent) => {
            if (activeId === null) return;
            // The dismiss gesture won this touch — stand down entirely.
            if (coverGestureArbiter.owner() === 'dismiss') {
                axis = 'declined';
                return;
            }
            if (axis === 'declined') return;
            const touch = findTouch(e);
            if (!touch) return;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            if (axis === 'none') {
                const adx = Math.abs(dx);
                const ady = Math.abs(dy);
                // Decide on the same ~4px threshold the face uses for its
                // vertical claim so neither side can win a near-diagonal race
                // the other should have. Horizontal-dominant + a swipeable
                // cover → claim; otherwise defer to the face.
                if (adx < 4 && ady < 4) return;
                const { isRadioActive: radio, isSongDefined: song } = coverStateRef.current;
                if (adx > ady && song && !radio && coverGestureArbiter.claimCover()) {
                    axis = 'x';
                } else {
                    axis = 'declined';
                    return;
                }
            }

            // We own the horizontal gesture: block the browser's own gestures
            // and track the finger 1:1.
            e.preventDefault();
            const now = performance.now();
            const dt = Math.max(1, now - lastT);
            velocityX = ((touch.clientX - lastX) / dt) * 1000;
            lastX = touch.clientX;
            lastT = now;
            coverSwipeX.set(dx);
        };

        const settle = (commit: boolean) => {
            const wasX = axis === 'x';
            activeId = null;
            axis = 'none';
            coverGestureArbiter.release();
            stopSnapBack();
            if (!wasX) return;

            if (!commit) {
                // touchcancel — snap back, never change tracks.
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 28,
                    stiffness: 360,
                    type: 'spring',
                });
                return;
            }

            const {
                hasNext: hN,
                hasPrevious: hP,
                isRadioActive: radio,
                isSongDefined: song,
                mediaNext: next,
                mediaPrevious: prev,
            } = coverStateRef.current;
            const width = mainImageRef.current?.offsetWidth ?? 320;
            const offset = coverSwipeX.get();
            // velocityX is the last move interval's instantaneous velocity,
            // frozen between moves. If the finger flicked fast then held still
            // before lifting, that frozen value would phantom-commit a track
            // change the user cancelled by pausing. Decay it to 0 once the
            // finger has been still longer than a frame or two, so a held
            // release falls back to the offset-only commit rule.
            const sinceLast = performance.now() - lastT;
            const releaseVelocity = sinceLast > 120 ? 0 : velocityX;
            const decision = decideCoverSwipeCommit({
                coverWidth: width,
                hasNext: hN,
                hasPrevious: hP,
                isRadioActive: radio,
                isSongDefined: song,
                offsetX: offset,
                velocityX: releaseVelocity,
            });

            if (decision === 'next') {
                console.info('[cover-swipe] commit next', { offset, velocity: releaseVelocity });
                triggerHaptic('selection');
                next();
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 30,
                    stiffness: 220,
                    type: 'spring',
                    velocity: releaseVelocity,
                });
            } else if (decision === 'previous') {
                console.info('[cover-swipe] commit prev', { offset, velocity: releaseVelocity });
                triggerHaptic('selection');
                prev();
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 30,
                    stiffness: 220,
                    type: 'spring',
                    velocity: releaseVelocity,
                });
            } else {
                console.info('[cover-swipe] snap back', {
                    hasNext: hN,
                    hasPrevious: hP,
                    offset,
                    velocity: releaseVelocity,
                });
                // No injected velocity: this branch is also hit by a
                // commit-magnitude flick at a queue boundary (no next/prev
                // cover behind it), and carrying flick velocity would fling
                // the cover into the empty space before springing back — the
                // exact "slide off and back" artifact the carousel avoids.
                snapBackRef.current = animate(coverSwipeX, 0, {
                    damping: 28,
                    stiffness: 360,
                    type: 'spring',
                });
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (activeId === null) return;
            // Only settle when OUR tracked finger lifted; ignore other fingers
            // lifting while ours is still down.
            if (!findTouch(e) && e.touches.length > 0) return;
            settle(true);
        };

        const onTouchCancel = (e: TouchEvent) => {
            if (activeId === null) return;
            // Only abort when OUR tracked finger is the cancelled one (or no
            // touches remain). A non-tracked finger lost to palm rejection or
            // a system edge gesture must not abort a swipe the still-down
            // primary finger is driving.
            if (!findTouch(e) && e.touches.length > 0) return;
            settle(false);
        };

        el.addEventListener('touchstart', onTouchStart, { passive: true });
        el.addEventListener('touchmove', onTouchMove, { passive: false });
        el.addEventListener('touchend', onTouchEnd, { passive: true });
        el.addEventListener('touchcancel', onTouchCancel, { passive: true });
        return () => {
            el.removeEventListener('touchstart', onTouchStart);
            el.removeEventListener('touchmove', onTouchMove);
            el.removeEventListener('touchend', onTouchEnd);
            el.removeEventListener('touchcancel', onTouchCancel);
            // If we still owned the gesture when the listener tears down
            // (e.g. isRemote flipped to a Connect target mid-swipe, with the
            // finger still down and no touchend coming), cancel any pending
            // spring, re-center the motion value so the cover isn't left
            // off-screen when the user returns to local mode, and hand the
            // arbiter back so the face isn't permanently suspended.
            if (axis === 'x') {
                stopSnapBack();
                coverSwipeX.set(0);
                coverGestureArbiter.release();
            }
        };
    }, [coverSwipeX, isRemote, stopSnapBack]);

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
    // Peek covers are gated on isRadioActive (not isPlayingRadio): a
    // radio stream that's loaded but paused still has no meaningful
    // prev/next, and we don't want a swipe on it to fire mediaNext().
    const nextImageSrc = !isRadioActive && nextSong?._uniqueId ? nextImageUrl : null;
    const previousImageSrc = !isRadioActive && previousSong?._uniqueId ? previousImageUrl : null;

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
                // Marker the player-face touch listener looks for, and the
                // element our own native touch listener (see the effect
                // above) attaches to. Because this is an inner node it runs
                // before the face's .playerState listener in DOM bubble
                // order, so `coverGestureArbiter` resolves the cover-vs-
                // dismiss axis race deterministically on every move. The
                // CSS sets `touch-action: pan-y` on this attribute so the
                // browser keeps vertical pans (native scroll + dismiss)
                // while we own the horizontal axis.
                data-cover-swipe
                ref={coverRef}
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
