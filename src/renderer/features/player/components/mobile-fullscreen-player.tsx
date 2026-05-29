import type { MotionValue, Variants } from 'motion/react';

import { animate, AnimatePresence, motion, useMotionValue } from 'motion/react';
import {
    CSSProperties,
    memo,
    MouseEvent,
    ReactNode,
    useCallback,
    useEffect,
    useRef,
    useState,
} from 'react';
import { lazy as lazyImport, Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './mobile-fullscreen-player.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { useActiveNowPlayingItem } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useHasLyrics } from '/@/renderer/features/lyrics/api/lyrics-api';
import { Lyrics } from '/@/renderer/features/lyrics/lyrics';
import { PlayQueue } from '/@/renderer/features/now-playing/components/play-queue';
import { MobileFullscreenAlbumCard } from '/@/renderer/features/player/components/mobile-fullscreen-album-card';
import { MobileFullscreenArtistCard } from '/@/renderer/features/player/components/mobile-fullscreen-artist-card';
import { MobileFullscreenPlayerAlbumArt } from '/@/renderer/features/player/components/mobile-fullscreen-player-album-art';
import { MobileFullscreenPlayerBottomControls } from '/@/renderer/features/player/components/mobile-fullscreen-player-bottom-controls';
import { MobileFullscreenPlayerControls } from '/@/renderer/features/player/components/mobile-fullscreen-player-controls';
import { MobileFullscreenPlayerHeader } from '/@/renderer/features/player/components/mobile-fullscreen-player-header';
import { MobileFullscreenPlayerMetadata } from '/@/renderer/features/player/components/mobile-fullscreen-player-metadata';
import { MobileFullscreenPlayerProgress } from '/@/renderer/features/player/components/mobile-fullscreen-player-progress';
import { MobileFullscreenPlayerVolume } from '/@/renderer/features/player/components/mobile-fullscreen-player-volume';
import { MobileFullscreenVisualizerCard } from '/@/renderer/features/player/components/mobile-fullscreen-visualizer-card';
import { coverGestureArbiter } from '/@/renderer/features/player/utils/cover-swipe-signal';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { ComponentErrorBoundary } from '/@/renderer/features/shared/components/component-error-boundary';
import { useSetFavorite } from '/@/renderer/features/shared/hooks/use-set-favorite';
import { useSetRating } from '/@/renderer/features/shared/hooks/use-set-rating';
import { useFastAverageColor } from '/@/renderer/hooks';
import {
    useCurrentServer,
    useFullScreenPlayerActiveTab,
    useFullScreenPlayerDynamicBackground,
    useFullScreenPlayerDynamicImageBlur,
    useFullScreenPlayerDynamicIsImage,
    useFullScreenPlayerStoreActions,
    useFullScreenPlayerVisualizerAsBackground,
    useFullScreenPlayerVisualizerExpanded,
    usePlayerData,
    usePlayerSong,
    useSetFullScreenPlayerStore,
    useShowRatings,
} from '/@/renderer/store';
import { usePlaybackSettings, useSettingsStore } from '/@/renderer/store/settings.store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Text } from '/@/shared/components/text/text';
import { LibraryItem, ServerType } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

const AudioMotionAnalyzerVisualizer = lazyImport(() =>
    import('/@/renderer/features/visualizer/components/audiomotionanalyzer/visualizer').then(
        (module) => ({ default: module.Visualizer }),
    ),
);

const ButterchurnVisualizer = lazyImport(() =>
    import('/@/renderer/features/visualizer/components/butternchurn/visualizer').then((module) => ({
        default: module.Visualizer,
    })),
);

/**
 * Inline visualizer-as-background. Rendered behind the player face when
 * the user has flipped `visualizerAsBackground` in the fullscreen player
 * config menu. Sits in the same layer as BackgroundImage / overlay,
 * just farther back, and the existing dim overlay sits on top so the
 * controls remain legible.
 *
 * Bails when webAudio isn't available — no analyzer to drive the visuals.
 * Suspends quickly with no fallback so first-paint isn't blocked on the
 * visualizer chunk loading.
 */
const FullscreenVisualizerBackground = memo(() => {
    const { webAudio } = usePlaybackSettings();
    const visualizerType = useSettingsStore((store) => store.visualizer.type);
    // Leaf selectors so this memo doesn't re-render on tab swap / opacity drag.
    const visualizerAsBackground = useFullScreenPlayerVisualizerAsBackground();
    const visualizerExpanded = useFullScreenPlayerVisualizerExpanded();

    if (!webAudio || !visualizerAsBackground || visualizerExpanded) {
        return null;
    }

    return (
        <>
            <div className={styles.visualizerBackground}>
                <ComponentErrorBoundary>
                    <Suspense fallback={null}>
                        {visualizerType === 'butterchurn' ? (
                            <ButterchurnVisualizer />
                        ) : (
                            <AudioMotionAnalyzerVisualizer />
                        )}
                    </Suspense>
                </ComponentErrorBoundary>
            </div>
            <div className={styles.visualizerBackgroundScrim} />
        </>
    );
});

FullscreenVisualizerBackground.displayName = 'FullscreenVisualizerBackground';

const mainBackground = 'var(--theme-colors-background)';

/**
 * Relative-luminance proxy (CCIR 601 / Rec. 601) for an `rgb(r, g, b)`
 * string. Returns null when the input doesn't look like an rgb() colour.
 *
 * We use the perceptual weights so a yellow album (high R+G, low B,
 * luminance ~226) correctly reads as "bright" — the simpler L = (r+g+b)/3
 * proxy would underestimate it because the blue channel is near zero.
 *
 * The returned value is on the 0–255 scale, matching the channel inputs.
 */
const rgbLuminance = (color: string | undefined): null | number => {
    if (!color) return null;
    const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return null;
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    return 0.299 * r + 0.587 * g + 0.114 * b;
};

/**
 * If `color` is brighter than `threshold` (0–255 scale, default 160 — the
 * point at which white text on the colour starts losing contrast against
 * WCAG AA), return a darkened version with each channel multiplied by
 * `factor`. Otherwise return the input untouched.
 *
 * This is the readability fix for the dynamic-background fullscreen
 * player: yellow / cream / pastel album covers used to paint the whole
 * face with a colour brighter than the white text on top, leaving the
 * title / artist / progress times invisible. We "ground" bright dominant
 * colours into the same low-luminance zone as the rest of the dark theme
 * so the text retains contrast no matter what the cover looks like.
 */
const darkenIfBright = (color: string | undefined, threshold = 160, factor = 0.32): string => {
    if (!color) return mainBackground;
    const L = rgbLuminance(color);
    if (L === null || L < threshold) return color;
    const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return color;
    const r = Math.round(Number(m[1]) * factor);
    const g = Math.round(Number(m[2]) * factor);
    const b = Math.round(Number(m[3]) * factor);
    return `rgb(${r}, ${g}, ${b})`;
};

const backgroundImageVariants: Variants = {
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

interface BackgroundImageProps {
    dynamicBackground: boolean | undefined;
    dynamicIsImage: boolean | undefined;
}

const BackgroundImage = memo(({ dynamicBackground, dynamicIsImage }: BackgroundImageProps) => {
    const currentSong = usePlayerSong();
    const { nextSong } = usePlayerData();

    const currentImageUrl = useItemImageUrl({
        id: currentSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });

    const nextImageUrl = useItemImageUrl({
        id: nextSong?.imageId || undefined,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });

    const [imageState, setImageState] = useState({
        bottomImage: nextImageUrl,
        current: 0,
        topImage: currentImageUrl,
    });

    const previousSongRef = useRef<string | undefined>(currentSong?._uniqueId);
    const imageStateRef = useRef(imageState);

    useEffect(() => {
        imageStateRef.current = imageState;
    }, [imageState]);

    // Update images when song changes
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
    }, [currentSong?._uniqueId, currentImageUrl, nextSong?._uniqueId, nextImageUrl]);

    if (!dynamicBackground || !dynamicIsImage) {
        return null;
    }

    const getBackgroundImageUrl = (
        imageUrl: string | undefined,
        songId: string | undefined,
        albumId: string | undefined,
    ) => {
        if (!imageUrl || !songId || !albumId) {
            return imageUrl;
        }
        return imageUrl.replace(songId, albumId);
    };

    // Determine which song IDs to use for keys and image URLs
    const topSongId = imageState.current === 0 ? currentSong?._uniqueId : nextSong?._uniqueId;
    const bottomSongId = imageState.current === 0 ? nextSong?._uniqueId : currentSong?._uniqueId;
    const topSong = imageState.current === 0 ? currentSong : nextSong;
    const bottomSong = imageState.current === 0 ? nextSong : currentSong;

    return (
        <AnimatePresence initial={false} mode="sync">
            {imageState.current === 0 && imageState.topImage && (
                <motion.div
                    animate="open"
                    className={styles.backgroundImage}
                    custom={{ isOpen: imageState.current === 0 }}
                    exit="closed"
                    initial="open"
                    key={`top-${topSongId || 'none'}`}
                    style={
                        {
                            backgroundImage: imageState.topImage
                                ? `url("${getBackgroundImageUrl(
                                      imageState.topImage,
                                      topSong?.id,
                                      topSong?.albumId,
                                  )}"), url("${imageState.topImage}")`
                                : undefined,
                        } as CSSProperties
                    }
                    variants={backgroundImageVariants}
                />
            )}

            {imageState.current === 1 && imageState.bottomImage && (
                <motion.div
                    animate="open"
                    className={styles.backgroundImage}
                    custom={{ isOpen: imageState.current === 1 }}
                    exit="closed"
                    initial="open"
                    key={`bottom-${bottomSongId || 'none'}`}
                    style={
                        {
                            backgroundImage: imageState.bottomImage
                                ? `url("${getBackgroundImageUrl(
                                      imageState.bottomImage,
                                      bottomSong?.id,
                                      bottomSong?.albumId,
                                  )}"), url("${imageState.bottomImage}")`
                                : undefined,
                        } as CSSProperties
                    }
                    variants={backgroundImageVariants}
                />
            )}
        </AnimatePresence>
    );
});

BackgroundImage.displayName = 'BackgroundImage';

const overlayVariants: Variants = {
    closed: {
        opacity: 0,
        transition: {
            duration: 0,
        },
    },
    initial: {
        opacity: 1,
    },
    open: {
        opacity: 1,
        transition: {
            duration: 0,
        },
    },
};

interface BackgroundImageOverlayProps {
    dynamicBackground: boolean | undefined;
    dynamicImageBlur: number | undefined;
}

const BackgroundImageOverlay = memo(
    ({ dynamicBackground, dynamicImageBlur }: BackgroundImageOverlayProps) => {
        const currentSong = usePlayerSong();
        const { nextSong } = usePlayerData();

        const [overlayState, setOverlayState] = useState({
            bottomSongId: nextSong?._uniqueId,
            current: 0,
            topSongId: currentSong?._uniqueId,
        });

        const previousSongRef = useRef<string | undefined>(currentSong?._uniqueId);
        const overlayStateRef = useRef(overlayState);

        useEffect(() => {
            overlayStateRef.current = overlayState;
        }, [overlayState]);

        // Update overlays when song changes
        useEffect(() => {
            if (currentSong?._uniqueId === previousSongRef.current) {
                return;
            }

            const isTop = overlayStateRef.current.current === 0;

            setOverlayState({
                bottomSongId: isTop ? currentSong?._uniqueId : nextSong?._uniqueId,
                current: isTop ? 1 : 0,
                topSongId: isTop ? nextSong?._uniqueId : currentSong?._uniqueId,
            });

            previousSongRef.current = currentSong?._uniqueId;
        }, [currentSong?._uniqueId, nextSong?._uniqueId]);

        if (!dynamicBackground) {
            return null;
        }

        return (
            <AnimatePresence initial={false} mode="sync">
                {overlayState.current === 0 && (
                    <motion.div
                        animate="open"
                        className={styles.backgroundImageOverlay}
                        exit="closed"
                        initial="open"
                        key={`top-${overlayState.topSongId || 'none'}`}
                        style={
                            {
                                '--image-blur': `${dynamicImageBlur ?? 0}rem`,
                            } as CSSProperties
                        }
                        variants={overlayVariants}
                    />
                )}

                {overlayState.current === 1 && (
                    <motion.div
                        animate="open"
                        className={styles.backgroundImageOverlay}
                        exit="closed"
                        initial="open"
                        key={`bottom-${overlayState.bottomSongId || 'none'}`}
                        style={
                            {
                                '--image-blur': `${dynamicImageBlur ?? 0}rem`,
                            } as CSSProperties
                        }
                        variants={overlayVariants}
                    />
                )}
            </AnimatePresence>
        );
    },
);

BackgroundImageOverlay.displayName = 'BackgroundImageOverlay';

interface DismissibleMobilePlayerContainerProps extends MobilePlayerContainerProps {
    /**
     * Shared motion value that drives the container's vertical position.
     * Native touch listeners attached in the parent update this directly;
     * mounting / unmounting / dismiss all also drive it imperatively via
     * animate(). Replaces Motion's `drag="y"` setup because the drag
     * gesture kept being eaten by the browser's overscroll bounce — see
     * the comment at the touchmove listener for the full story.
     */
    swipeY: MotionValue<number>;
}

interface MobilePlayerContainerProps {
    children: ReactNode;
    dynamicBackground: boolean | undefined;
    dynamicIsImage: boolean | undefined;
}

const MobilePlayerContainer = memo(
    ({
        children,
        dynamicBackground,
        dynamicIsImage,
        swipeY,
    }: DismissibleMobilePlayerContainerProps) => {
        const currentSong = usePlayerSong();
        const imageUrl = useItemImageUrl({
            id: currentSong?.imageId || undefined,
            imageUrl: currentSong?.imageUrl,
            itemType: LibraryItem.SONG,
            type: 'itemCard',
        });
        const { background } = useFastAverageColor({
            algorithm: 'dominant',
            src: imageUrl,
            srcLoaded: true,
        });

        // Darken the dominant colour before using it as the page background
        // so bright covers (the canonical case: yellow / cream / pastel
        // albums) don't wash out the white text on top. See darkenIfBright
        // above for the WCAG-AA reasoning. The blended-image variant keeps
        // alpha 0.3 so it tints rather than replaces the cover-image
        // backdrop, but the underlying RGB still gets the darken pass.
        const grounded = darkenIfBright(background);
        let backgroundColor = mainBackground;
        if (dynamicBackground) {
            if (dynamicIsImage && background) {
                const rgbMatch = grounded.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
                if (rgbMatch) {
                    backgroundColor = `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, 0.3)`;
                } else {
                    backgroundColor = grounded;
                }
            } else {
                backgroundColor = grounded;
            }
        }

        // When the source colour is bright, also strengthen the overlay
        // that sits on top of the cover-image backdrop so the title /
        // progress / control row stay legible. The CSS reads from
        // --mobile-fullscreen-overlay-strength on the container — see
        // .background-image-overlay in mobile-fullscreen-player.module.css.
        const sourceLuminance = rgbLuminance(background);
        const overlayStrength = sourceLuminance !== null && sourceLuminance > 160 ? '0.72' : '0.42';

        /*
         * Dismiss is fully manual now: parent component drives `swipeY`
         * from a non-passive touchmove listener on the scroll surface
         * (see useEffect below `MobileFullscreenPlayer`). Motion's own
         * `drag` prop is gone — every attempt to coordinate it with the
         * inner scroll lost the gesture race to the browser's overscroll
         * bounce. Pull-to-refresh / pull-to-dismiss in WebViews ultimately
         * has to call preventDefault() on the very first downward
         * touchmove, which Motion couldn't reach in time through its
         * passive event listeners.
         */

        return (
            <motion.div
                className={styles.container}
                style={
                    {
                        '--mobile-fullscreen-overlay-strength': overlayStrength,
                        backgroundColor,
                        y: swipeY,
                    } as unknown as CSSProperties
                }
            >
                <BackgroundImage
                    dynamicBackground={dynamicBackground}
                    dynamicIsImage={dynamicIsImage}
                />
                {children}
            </motion.div>
        );
    },
);

MobilePlayerContainer.displayName = 'MobilePlayerContainer';

// (mobileContainerVariants removed — the container's vertical position is now
// driven by the `swipeY` motion value, animated imperatively on mount,
// dismiss, and snap-back. See `animate(swipeY, ...)` calls in
// MobileFullscreenPlayer below.)

export const MobileFullscreenPlayer = () => {
    const { t } = useTranslation();
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();
    // Leaf selectors. Previously a single `useFullScreenPlayerStore()` read
    // re-rendered the entire mobile fullscreen player on every store change
    // (expanded toggle, opacity drag, visualizerExpanded flip), which is
    // catastrophic at this depth (parent of album-art crossfade,
    // background-image stack, etc.). Each leaf is referentially stable
    // when its slice doesn't change.
    const activeTab = useFullScreenPlayerActiveTab();
    const dynamicBackground = useFullScreenPlayerDynamicBackground();
    const dynamicImageBlur = useFullScreenPlayerDynamicImageBlur();
    const dynamicIsImage = useFullScreenPlayerDynamicIsImage();
    const visualizerAsBackground = useFullScreenPlayerVisualizerAsBackground();
    const currentSong = usePlayerSong();
    // The song to surface on the player face: the remote device's now-playing
    // when a Jellyfin Connect target is active, else the local song (no-op
    // locally). `currentSong` is kept for local-only secondary surfaces
    // (lyrics, related-artist/album cards, context menu).
    const displaySong = useActiveNowPlayingItem();
    const isRadioActive = useIsRadioActive();
    const { isPlaying: isRadioPlaying, metadata: radioMetadata, stationName } = useRadioPlayer();
    const server = useCurrentServer();

    const isPlayingRadio = isRadioActive && isRadioPlaying;
    const { webAudio: webAudioEnabled } = usePlaybackSettings();
    /*
     * When the visualizer is the chosen background AND Web Audio is
     * enabled (so the visualizer can actually run), suppress the
     * album-art-derived dynamic background — they painted on top of
     * each other and the cover bled through any quiet sections of
     * the visualizer canvas. If Web Audio is off, fall back to the
     * dynamic background so the user doesn't see a dark void where
     * the visualizer should have been.
     */
    const effectiveDynamicBackground =
        dynamicBackground && !isPlayingRadio && !(visualizerAsBackground && webAudioEnabled);
    const setFavorite = useSetFavorite();
    const showRatingsSetting = useShowRatings();
    const setRating = useSetRating();

    const [isPageHovered, setIsPageHovered] = useState(false);
    /*
     * `null` while the lyrics query is still loading (keep the card
     * shown so we don't flash hide → show); `false` once we know there
     * are no lyrics for this song; `true` when there's something to
     * render. The Lyrics component itself uses the same TanStack key
     * so the fetch only fires once.
     */
    // Lyrics now resolve against the active source (the Lyrics view does too),
    // so the affordance and content stay consistent in remote mode.
    const hasLyrics = useHasLyrics((displaySong ?? undefined) as typeof currentSong);

    /*
     * Manual pull-to-dismiss.
     *
     * Earlier rounds tried Motion's `drag="y"` and dragControls.start()
     * but both lost the gesture race to the browser's overscroll bounce
     * — by the time React's passive pointer listeners decided "this is a
     * drag" the browser had already committed to bouncing the scroll
     * container, and Motion's later preventDefault was a no-op. Even
     * touch-action: none on the player face wasn't enough because the
     * inner scroll surface also wants vertical pans.
     *
     * The only reliable Android WebView pattern is a non-passive native
     * `touchmove` listener that calls preventDefault() the moment we
     * detect a downward pull at scrollTop=0. Once preventDefault fires
     * for a touch sequence, the browser is permanently locked out of
     * scrolling it — so we then own the gesture and update `swipeY`
     * directly. Upward pulls and sideways moves never preventDefault,
     * so the browser's native scroll still works for revealing the
     * lyrics / artist cards below.
     */
    const playerStateRef = useRef<HTMLDivElement | null>(null);
    const swipeY = useMotionValue(typeof window !== 'undefined' ? window.innerHeight : 0);
    const isPlayerStateRef = useRef(true);
    const onDismissRef = useRef<() => void>(() => {});

    const handleToggleFullScreenPlayer = useCallback(() => {
        // Animate the player off-screen before unmounting so the close
        // button has the same dismissal feel as a swipe.
        const target = typeof window !== 'undefined' ? window.innerHeight : 0;
        animate(swipeY, target, {
            duration: 0.25,
            ease: 'easeInOut',
            onComplete: () => {
                setFullScreenPlayerStore({ expanded: false });
                swipeY.set(target);
            },
        });
    }, [setFullScreenPlayerStore, swipeY]);

    useEffect(() => {
        onDismissRef.current = handleToggleFullScreenPlayer;
    }, [handleToggleFullScreenPlayer]);

    // Entrance animation — slide up from the bottom of the viewport.
    useEffect(() => {
        const controls = animate(swipeY, 0, { duration: 0.45, ease: 'easeOut' });
        return () => controls.stop();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const el = playerStateRef.current;
        if (!el) return;
        // The active touch identifier. Like the cover listener, the face is
        // finger-aware: a second finger landing or lifting mid-dismiss must
        // not re-seed tracking, finalize the gesture early, or release the
        // shared arbiter out from under the still-down primary finger.
        let activeId: null | number = null;
        let startX = 0;
        let startY = 0;
        let active = false;
        let claimed = false;
        let lastY = 0;
        let lastTime = 0;

        const findTouch = (e: TouchEvent): null | Touch => {
            if (activeId === null) return null;
            for (let i = 0; i < e.changedTouches.length; i += 1) {
                const t = e.changedTouches[i];
                if (t.identifier === activeId) return t;
            }
            return null;
        };

        const onTouchStart = (e: TouchEvent) => {
            if (!isPlayerStateRef.current) return;
            // A gesture is already in flight — a second finger must not
            // re-seed startY / claimed / timers or wipe the arbiter claim.
            if (activeId !== null) return;
            // Fresh single-finger touch — reset the arbiter so a previous
            // gesture's owner can't leak into this one. The cover's listener
            // (inner element) also releases here; both setting 'none' is
            // idempotent.
            if (e.touches.length === 1) coverGestureArbiter.release();
            // The cover swipe owns the x-axis; vertical pulls dismiss. The
            // two coexist because the cover element sets touch-action: pan-y
            // (browser keeps vertical events flowing to us) and our touchmove
            // defers to the cover when it claims the gesture. Arbitration is
            // deterministic: the cover's listener runs first (inner node) and
            // claims on horizontal-dominant moves, so by the time we evaluate
            // this same move the owner is already settled.
            if (el.scrollTop > 0) return;
            const touch = e.changedTouches[0];
            if (!touch) return;
            activeId = touch.identifier;
            startX = touch.clientX;
            startY = touch.clientY;
            lastY = startY;
            lastTime = performance.now();
            active = true;
            claimed = false;
        };

        const onTouchMove = (e: TouchEvent) => {
            if (!active) return;
            // The cover claimed this touch for its horizontal swipe — stand
            // down so we don't accumulate swipeY and fight the cover. The
            // cover's listener runs before this one on the same event, so by
            // now the owner reflects this very move.
            if (coverGestureArbiter.owner() === 'cover') {
                active = false;
                return;
            }
            // Our tracked finger moves every frame while dragging, so it is
            // always in changedTouches; reading it (not touches[0]) avoids
            // tracking a second finger's coordinates during multi-touch.
            const touch = findTouch(e);
            if (!touch) return;
            const dy = touch.clientY - startY;
            const dx = Math.abs(touch.clientX - startX);

            if (!claimed) {
                // Decide direction off a small threshold. <=4px lets us
                // act before the browser commits to its scroll bounce.
                if (Math.abs(dy) < 4) return;
                if (dy < 0) {
                    // upward — let native scroll happen
                    active = false;
                    return;
                }
                if (dx > Math.abs(dy)) {
                    // mostly horizontal — bail so the cover swipe can claim it
                    active = false;
                    return;
                }
                // Downward-dominant pull at scrollTop 0: claim the dismiss.
                // Fails only if the cover somehow already owns this touch.
                if (!coverGestureArbiter.claimDismiss()) {
                    active = false;
                    return;
                }
                claimed = true;
            }

            // We own the gesture from here on; block native scroll.
            e.preventDefault();
            // Mild rubber-band so the drag feels weighty but not 1:1.
            swipeY.set(Math.max(0, dy * 0.75));
            lastY = touch.clientY;
            lastTime = performance.now();
        };

        const finish = (settle: 'dismiss-or-spring' | 'spring') => {
            const wasClaimed = claimed;
            const wasActive = active;
            activeId = null;
            active = false;
            claimed = false;
            // Release our claim so the next gesture starts clean. Guarded on
            // owner so we never clobber a claim the cover currently holds.
            if (coverGestureArbiter.owner() === 'dismiss') coverGestureArbiter.release();
            if (!wasActive || !wasClaimed) return;

            if (settle === 'spring') {
                // touchcancel — never dismiss, just snap back.
                animate(swipeY, 0, { damping: 30, stiffness: 380, type: 'spring' });
                return;
            }

            const offset = swipeY.get();
            // Recover finger velocity from the last move snapshot so a
            // flick dismisses even at small absolute offsets. A held-still
            // release inflates `elapsed` and decays velocity toward 0.
            const elapsed = Math.max(16, performance.now() - lastTime);
            const recentDy = lastY - startY;
            const velocity = (recentDy / elapsed) * 1000;

            const height = typeof window !== 'undefined' ? window.innerHeight : 800;
            if (offset > 140 || velocity > 500) {
                animate(swipeY, height, {
                    duration: 0.25,
                    ease: 'easeOut',
                    onComplete: () => {
                        onDismissRef.current();
                        swipeY.set(height);
                    },
                });
            } else {
                animate(swipeY, 0, { damping: 30, stiffness: 380, type: 'spring' });
            }
        };

        const onTouchEnd = (e: TouchEvent) => {
            if (activeId === null) return;
            // Ignore a non-tracked finger lifting while ours is still down.
            if (!findTouch(e) && e.touches.length > 0) return;
            finish('dismiss-or-spring');
        };

        const onTouchCancel = () => {
            if (activeId === null) return;
            finish('spring');
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
            // If we still owned the gesture when the listener tears down,
            // hand it back so the cover isn't permanently suspended.
            if (coverGestureArbiter.owner() === 'dismiss') coverGestureArbiter.release();
        };
    }, [swipeY]);

    const handleToggleContextMenu = useCallback(
        (e: MouseEvent<HTMLButtonElement | HTMLDivElement>) => {
            e.preventDefault();
            e.stopPropagation();

            if (!currentSong) {
                return;
            }

            ContextMenuController.call({
                cmd: { items: [currentSong], type: LibraryItem.SONG },
                event: e as unknown as MouseEvent<HTMLDivElement>,
            });
        },
        [currentSong],
    );

    const handleToggleQueue = useCallback(() => {
        setStore({ activeTab: activeTab === 'queue' ? 'player' : 'queue' });
    }, [activeTab, setStore]);

    const handleToggleFavorite = useCallback(
        (e: MouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            const song = displaySong;
            if (!song?.id) return;

            setFavorite(song._serverId, [song.id], LibraryItem.SONG, !song.userFavorite);
        },
        [displaySong, setFavorite],
    );

    const handleToggleLyrics = useCallback(() => {
        setStore({ activeTab: activeTab === 'lyrics' ? 'player' : 'lyrics' });
    }, [activeTab, setStore]);

    const handleUpdateRating = useCallback(
        (rating: number) => {
            if (!currentSong?.id) return;

            setRating(currentSong._serverId, [currentSong.id], LibraryItem.SONG, rating);
        },
        [currentSong, setRating],
    );

    const isPlayerState = activeTab !== 'queue' && activeTab !== 'lyrics';
    const isQueueState = activeTab === 'queue';
    const isLyricsState = activeTab === 'lyrics';
    const isSongDefined = Boolean(displaySong?.id);
    const showRating =
        showRatingsSetting &&
        isSongDefined &&
        (server?.type === ServerType.NAVIDROME || server?.type === ServerType.SUBSONIC);

    // Mirror the active-tab flag into a ref so the touch listener
    // (registered once at mount) can check it without re-binding on
    // every tab switch.
    isPlayerStateRef.current = isPlayerState;

    return (
        <MobilePlayerContainer
            dynamicBackground={effectiveDynamicBackground}
            dynamicIsImage={dynamicIsImage}
            swipeY={swipeY}
        >
            <FullscreenVisualizerBackground />
            <BackgroundImageOverlay
                dynamicBackground={effectiveDynamicBackground}
                dynamicImageBlur={dynamicImageBlur}
            />
            <motion.div
                animate={{
                    opacity: isPlayerState ? 1 : 0,
                    zIndex: isPlayerState ? 2 : 1,
                }}
                className={styles.playerState}
                onMouseEnter={() => setIsPageHovered(true)}
                onMouseLeave={() => setIsPageHovered(false)}
                ref={playerStateRef}
                transition={{ duration: 0.3, ease: 'easeInOut' }}
            >
                {/*
                 * Spotify-style card layout: the player face fills the
                 * viewport on first paint; scrolling down reveals
                 * stacked cards (lyrics preview, future artist/about
                 * card, etc.). The .playerFace div carries min-height:
                 * 100% so the controls always sit at the viewport edge
                 * on first paint regardless of how short the cover row
                 * is. The .lyricsCard below it appears as the user
                 * scrolls.
                 *
                 * Whole-face drag-to-dismiss is wired via a non-passive
                 * native touchmove listener on .playerState (see the
                 * useEffect that registers it). React's synthetic
                 * pointer events couldn't preventDefault in time, so we
                 * bypass React entirely for that gesture.
                 */}
                <div className={styles.playerFace}>
                    {/*
                     * Spotify/Apple-Music-style drag handle. Lives at the
                     * top of the player face as a visual cue that the
                     * surface is draggable; the actual gesture is handled
                     * by the native touch listener registered on
                     * .playerState below, so the pill itself doesn't
                     * need its own onPointerDown.
                     */}
                    <div aria-hidden className={styles.dragHandle}>
                        <div className={styles.dragHandlePill} />
                    </div>
                    <MobileFullscreenPlayerHeader
                        currentSong={currentSong}
                        isPageHovered={isPageHovered}
                        onClose={handleToggleFullScreenPlayer}
                    />
                    {/*
                     * Body wrapper for the cover + control-stack. In
                     * portrait this is `display: contents` so the
                     * children sit flat inside .playerFace's flex
                     * column. In landscape phone it switches to a
                     * 1fr/1fr grid: cover on the left, the control
                     * stack on the right — Spotify's tablet split
                     * layout. Without this wrapper the cover and
                     * controls would stack vertically in landscape
                     * too, which crams them into a 400px-tall window.
                     */}
                    <div className={styles.playerFaceBody}>
                        <MobileFullscreenPlayerAlbumArt />
                        <div className={styles.playerFaceControlStack}>
                            <MobileFullscreenPlayerMetadata
                                currentSong={displaySong ?? undefined}
                                onToggleFavorite={handleToggleFavorite}
                                onUpdateRating={handleUpdateRating}
                                radioArtist={
                                    isPlayingRadio
                                        ? (radioMetadata?.artist ?? undefined)
                                        : undefined
                                }
                                radioStationName={
                                    isPlayingRadio ? (stationName ?? undefined) : undefined
                                }
                                radioTitle={
                                    isPlayingRadio ? (radioMetadata?.title ?? undefined) : undefined
                                }
                                showRating={showRating}
                            />
                            <MobileFullscreenPlayerProgress
                                currentSong={displaySong ?? undefined}
                            />
                            <MobileFullscreenPlayerVolume />
                            <MobileFullscreenPlayerControls
                                currentSong={displaySong ?? undefined}
                            />
                        </div>
                    </div>
                    <MobileFullscreenPlayerBottomControls
                        isQueueActive={isQueueState}
                        onToggleContextMenu={handleToggleContextMenu}
                        onToggleQueue={handleToggleQueue}
                    />
                </div>

                {/*
                 * Scroll-down cards: lyrics + about-the-artist below the
                 * player face. Hidden when there's no song (empty queue
                 * on first launch). The existing fullscreen "Lyrics"
                 * tab still works for users who prefer the dedicated
                 * immersive view; this is the inline preview that
                 * matches Spotify's scrollable card stack.
                 */}
                {isSongDefined && (
                    <>
                        {!isPlayingRadio && (
                            <MobileFullscreenArtistCard
                                artistId={displaySong?.artists?.[0]?.id}
                                artistName={displaySong?.artists?.[0]?.name}
                            />
                        )}
                        {/*
                         * Only show the lyrics preview card once the
                         * query has resolved to something — empty
                         * lyrics would otherwise leave a card with a
                         * placeholder "no lyrics" message. While the
                         * query is loading we keep showing the card
                         * (the inner Lyrics component handles the
                         * loading state) to avoid a flash of hide-then-
                         * show once a result arrives.
                         *
                         * Hidden entirely when the expanded lyrics tab
                         * is active — both surfaces render the same
                         * SynchronizedLyrics component which collides
                         * on shared DOM ids (`lyric-N`, the scroll
                         * container), and document.getElementById was
                         * pinning the active line to whichever instance
                         * mounted first. With the inline card unmounted
                         * while expanded, the expanded view's lines
                         * advance normally.
                         */}
                        {hasLyrics !== false && !isLyricsState && (
                            <div
                                aria-label={t('page.fullscreenPlayer.openLyrics', {
                                    defaultValue: 'Tap to expand lyrics',
                                })}
                                className={styles.lyricsCard}
                                onClick={handleToggleLyrics}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        handleToggleLyrics();
                                    }
                                }}
                                role="button"
                                tabIndex={0}
                            >
                                <div className={styles.lyricsCardHeader}>
                                    <span>
                                        {t('page.fullscreenPlayer.lyrics', {
                                            defaultValue: 'Lyrics',
                                        })}
                                    </span>
                                    <span className={styles.lyricsCardHeaderHint}>
                                        {t('page.fullscreenPlayer.openLyrics', {
                                            defaultValue: 'Tap to expand',
                                        })}
                                    </span>
                                </div>
                                <div className={styles.lyricsCardBody}>
                                    <Lyrics fadeOutNoLyricsMessage />
                                </div>
                            </div>
                        )}
                        {!isPlayingRadio && (
                            <MobileFullscreenAlbumCard
                                albumId={displaySong?.albumId}
                                albumName={displaySong?.album ?? undefined}
                            />
                        )}
                        <MobileFullscreenVisualizerCard />
                    </>
                )}
            </motion.div>

            <AnimatePresence>
                {isQueueState && (
                    <motion.div
                        animate={{ opacity: 1 }}
                        className={styles.queueState}
                        exit={{ opacity: 0 }}
                        initial={{ opacity: 0 }}
                        style={{ zIndex: 2 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                    >
                        <div className={styles.queueHeader}>
                            <ActionIcon
                                aria-label={t('common.collapse')}
                                icon="arrowDownS"
                                onClick={handleToggleFullScreenPlayer}
                                size="sm"
                                variant={isPageHovered ? 'default' : 'subtle'}
                            />
                            <ActionIcon
                                aria-label={t('common.close')}
                                icon="x"
                                iconProps={{ size: 'xl' }}
                                onClick={handleToggleQueue}
                                size="sm"
                                variant={isPageHovered ? 'default' : 'subtle'}
                            />
                        </div>
                        <div className={styles.queueContent}>
                            <PlayQueue listKey={ItemListKey.FULL_SCREEN} searchTerm={undefined} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {isLyricsState && (
                    <motion.div
                        animate={{ opacity: 1 }}
                        className={styles.lyricsState}
                        exit={{ opacity: 0 }}
                        initial={{ opacity: 0 }}
                        style={{ zIndex: 2 }}
                        transition={{ duration: 0.3, ease: 'easeInOut' }}
                    >
                        <div className={styles.lyricsHeader}>
                            <ActionIcon
                                aria-label={t('common.collapse')}
                                icon="arrowDownS"
                                onClick={handleToggleFullScreenPlayer}
                                size="sm"
                                variant={isPageHovered ? 'default' : 'subtle'}
                            />
                            <Text fw={600} size="lg">
                                {t('page.fullscreenPlayer.lyrics')}
                            </Text>
                            <ActionIcon
                                aria-label={t('common.close')}
                                icon="x"
                                iconProps={{ size: 'xl' }}
                                onClick={handleToggleLyrics}
                                size="sm"
                                variant={isPageHovered ? 'default' : 'subtle'}
                            />
                        </div>
                        <div className={styles.lyricsContent}>
                            <Lyrics fadeOutNoLyricsMessage={false} />
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </MobilePlayerContainer>
    );
};
