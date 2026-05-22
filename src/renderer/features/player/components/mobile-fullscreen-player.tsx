import type { DragControls } from 'motion/react';

import { AnimatePresence, motion, useDragControls } from 'motion/react';
import { Variants } from 'motion/react';
import {
    CSSProperties,
    memo,
    MouseEvent,
    PointerEvent,
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
    useFullScreenPlayerStore,
    useFullScreenPlayerStoreActions,
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
    const { visualizerAsBackground, visualizerExpanded } = useFullScreenPlayerStore();

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
     * Drag controls created by the parent and shared with the drag handle so
     * a pointerdown on the handle hands the gesture straight to Motion's
     * drag state on this container — no manual pointermove tracking needed.
     */
    dragControls: DragControls;
    /** True while the player face (cover/metadata/transport) is the active tab. */
    isPlayerTab: boolean;
    onDismiss: () => void;
}

interface MobilePlayerContainerProps {
    children: ReactNode;
    dynamicBackground: boolean | undefined;
    dynamicIsImage: boolean | undefined;
    /**
     * Fired when the user drags the fullscreen player downward past the
     * dismiss threshold or flicks it down fast — closes the overlay.
     */
    onDismiss?: () => void;
}

const MobilePlayerContainer = memo(
    ({
        children,
        dragControls,
        dynamicBackground,
        dynamicIsImage,
        isPlayerTab,
        onDismiss,
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
         * Pull-to-dismiss. We previously tried to track raw pointer
         * events on the container and call dragControls.start() once
         * we saw a downward pull at scrollTop=0, but that gesture
         * never reliably reached us — the inner scroll surface and
         * Motion's own pointer plumbing kept eating the events.
         *
         * The robust pattern is a dedicated drag handle (the visible
         * pill at the top of the player face) whose onPointerDown
         * hands the gesture directly to Motion's drag state on this
         * container. dragControls is created up in MobileFullscreenPlayer
         * and threaded down to both this container and the handle so
         * they share state.
         */

        return (
            <motion.div
                animate="open"
                className={styles.container}
                drag={isPlayerTab ? 'y' : false}
                dragConstraints={{ bottom: 0, left: 0, right: 0, top: 0 }}
                dragControls={dragControls}
                dragElastic={{ bottom: 0.6, top: 0 }}
                // dragListener=false: don't auto-start drag on pointer
                // events. The drag fires exclusively from the handle
                // pill calling dragControls.start(), so taps on the
                // cover / metadata / transport stay click-only.
                dragListener={false}
                exit="closed"
                initial="closed"
                // Past ~140px of downward drag (or a fast flick), dismiss.
                // Below that we snap back to the resting position.
                onDragEnd={(_, info) => {
                    if (info.offset.y > 140 || info.velocity.y > 500) {
                        onDismiss();
                    }
                }}
                style={
                    {
                        '--mobile-fullscreen-overlay-strength': overlayStrength,
                        backgroundColor,
                    } as CSSProperties
                }
                variants={mobileContainerVariants}
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

const mobileContainerVariants: Variants = {
    closed: {
        transition: {
            duration: 0.5,
            ease: 'easeInOut',
        },
        y: '100%',
    },
    open: {
        transition: {
            duration: 0.5,
            ease: 'easeInOut',
        },
        y: 0,
    },
};

export const MobileFullscreenPlayer = () => {
    const { t } = useTranslation();
    const setFullScreenPlayerStore = useSetFullScreenPlayerStore();
    const { setStore } = useFullScreenPlayerStoreActions();
    const {
        activeTab,
        dynamicBackground,
        dynamicImageBlur,
        dynamicIsImage,
        visualizerAsBackground,
    } = useFullScreenPlayerStore();
    const currentSong = usePlayerSong();
    const { currentSong: currentSongData } = usePlayerData();
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
     * Shared drag controls — wired into the container's drag="y" state
     * AND into the drag-handle pill below. The handle's onPointerDown
     * calls dragControls.start(e), which is what actually makes the
     * swipe-down-to-dismiss work; if we left Motion's normal listener
     * on, the inner scrollable card-stack would race the gesture and
     * the dismiss would never fire.
     */
    const dragControls = useDragControls();
    const handleHandlePointerDown = useCallback(
        (event: PointerEvent<HTMLDivElement>) => {
            dragControls.start(event.nativeEvent);
        },
        [dragControls],
    );

    const handleToggleFullScreenPlayer = useCallback(() => {
        setFullScreenPlayerStore({ expanded: false });
    }, [setFullScreenPlayerStore]);

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
            const song = currentSongData;
            if (!song?.id) return;

            setFavorite(song._serverId, [song.id], LibraryItem.SONG, !song.userFavorite);
        },
        [currentSongData, setFavorite],
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
    const isSongDefined = Boolean(currentSong?.id);
    const showRating =
        showRatingsSetting &&
        isSongDefined &&
        (server?.type === ServerType.NAVIDROME || server?.type === ServerType.SUBSONIC);

    return (
        <MobilePlayerContainer
            dragControls={dragControls}
            dynamicBackground={effectiveDynamicBackground}
            dynamicIsImage={dynamicIsImage}
            isPlayerTab={isPlayerState}
            onDismiss={handleToggleFullScreenPlayer}
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
                 */}
                <div className={styles.playerFace}>
                    {/*
                     * Spotify/Apple-Music-style drag handle. Living at the
                     * top of the player face means it scrolls away once the
                     * user pulls the card stack up — they can't dismiss
                     * by accident while reading lyrics / artist info, which
                     * matches the platform pattern. onPointerDown calls
                     * dragControls.start() directly; Motion handles the
                     * rest. The pill itself is purely cosmetic — the hit
                     * area is the surrounding padding.
                     */}
                    <div
                        aria-label={t('common.minimize', { defaultValue: 'Swipe down to close' })}
                        className={styles.dragHandle}
                        onPointerDown={handleHandlePointerDown}
                        role="button"
                        tabIndex={-1}
                    >
                        <div aria-hidden className={styles.dragHandlePill} />
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
                                currentSong={currentSong}
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
                            <MobileFullscreenPlayerProgress currentSong={currentSong} />
                            <MobileFullscreenPlayerVolume />
                            <MobileFullscreenPlayerControls currentSong={currentSong} />
                        </div>
                    </div>
                    <MobileFullscreenPlayerBottomControls
                        isLyricsActive={isLyricsState}
                        isQueueActive={isQueueState}
                        onToggleContextMenu={handleToggleContextMenu}
                        onToggleLyrics={handleToggleLyrics}
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
                                artistId={currentSong?.artists?.[0]?.id}
                                artistName={currentSong?.artists?.[0]?.name}
                            />
                        )}
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
                        {!isPlayingRadio && (
                            <MobileFullscreenAlbumCard
                                albumId={currentSong?.albumId}
                                albumName={currentSong?.album ?? undefined}
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
