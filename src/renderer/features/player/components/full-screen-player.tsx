import clsx from 'clsx';
import { AnimatePresence, motion, Variants } from 'motion/react';
import { CSSProperties, memo, ReactNode, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';

import styles from './full-screen-player.module.css';

import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { FullScreenPlayerImage } from '/@/renderer/features/player/components/full-screen-player-image';
import {
    FullScreenPlayerControls,
    FullScreenPlayerQueue,
} from '/@/renderer/features/player/components/full-screen-player-queue';
import { SharedFullscreenPlayerSettings } from '/@/renderer/features/player/components/shared-full-screen-player-settings';
import { useCrossfadeImageSlots } from '/@/renderer/features/player/hooks/use-crossfade-image-slots';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import { useFastAverageColor } from '/@/renderer/hooks';
import {
    useFullScreenPlayerActiveTab,
    useFullScreenPlayerDynamicBackground,
    useFullScreenPlayerDynamicImageBlur,
    useFullScreenPlayerDynamicIsImage,
    useFullScreenPlayerOpacity,
    useFullScreenPlayerStoreActions,
    usePlayerData,
    usePlayerSong,
    useWindowSettings,
} from '/@/renderer/store';
import { Group } from '/@/shared/components/group/group';
import { LibraryItem } from '/@/shared/types/domain-types';
import { Platform } from '/@/shared/types/types';

const mainBackground = 'var(--theme-colors-background)';

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

    // Cache-first, and keyed on albumId: the sweep caches covers by album, and
    // on Subsonic/Navidrome a song's imageId is the coverArt id, not the album
    // id — keying on it alone renders a blank cover.
    const currentImageUrl = useCachedItemImageUrl({
        id: currentSong?.albumId ?? currentSong?.imageId ?? undefined,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });

    const nextImageUrl = useCachedItemImageUrl({
        id: nextSong?.albumId ?? nextSong?.imageId ?? undefined,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });

    const imageState = useCrossfadeImageSlots({
        currentImageUrl,
        nextImageUrl,
        songKey: currentSong?._uniqueId,
    });

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

    // The song whose art backs each slot (only for the getBackgroundImageUrl id
    // remap). The AnimatePresence key below is SLOT-stable, not song-derived, so
    // a track change on the render before the crossfade flips can't spawn a
    // spurious backdrop transition (and can't desync from imageState).
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
                    initial="closed"
                    key="bg-top"
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
                    initial="closed"
                    key="bg-bottom"
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

interface BackgroundImageOverlayProps {
    dynamicBackground: boolean | undefined;
    dynamicImageBlur: number | undefined;
}

const BackgroundImageOverlay = memo(
    ({ dynamicBackground, dynamicImageBlur }: BackgroundImageOverlayProps) => {
        if (!dynamicBackground) {
            return null;
        }

        return (
            <div
                className={styles.backgroundImageOverlay}
                style={
                    {
                        '--image-blur': `${dynamicImageBlur ?? 0}rem`,
                    } as CSSProperties
                }
            />
        );
    },
);

BackgroundImageOverlay.displayName = 'BackgroundImageOverlay';

interface BackgroundOverlayProps {
    dynamicBackground: boolean | undefined;
    opacity: number;
}

const BackgroundOverlay = memo(({ dynamicBackground, opacity }: BackgroundOverlayProps) => {
    if (!dynamicBackground) {
        return null;
    }

    // Opacity is divided by 120 instead of 100, to prevent a complete black background at maximum opacity
    const alpha = Math.min(1, Math.max(0, opacity / 120));

    return (
        <div
            className={styles.backgroundOverlay}
            style={{ backgroundColor: `rgba(0, 0, 0, ${alpha})` }}
        />
    );
});

BackgroundOverlay.displayName = 'BackgroundOverlay';

const containerVariants: Variants = {
    closed: (custom) => {
        const { windowBarStyle } = custom;
        return {
            height:
                windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS
                    ? 'calc(100vh - 120px)'
                    : 'calc(100vh - 90px)',
            position: 'absolute',
            top: '100vh',
            transition: {
                duration: 0.5,
                ease: 'easeOut',
            },
            width: '100vw',
            y: 0,
        };
    },
    open: (custom) => {
        const { background, dynamicBackground, windowBarStyle } = custom;
        return {
            backgroundColor: dynamicBackground ? background : mainBackground,
            height:
                windowBarStyle === Platform.WINDOWS || windowBarStyle === Platform.MACOS
                    ? 'calc(100vh - 120px)'
                    : 'calc(100vh - 90px)',
            left: 0,
            position: 'absolute',
            top: 0,
            transition: {
                delay: 0.1,
                duration: 0.5,
                ease: 'easeOut',
            },
            width: '100vw',
            y: 0,
        };
    },
};

interface PlayerContainerProps {
    children: ReactNode;
    dynamicBackground: boolean | undefined;
    dynamicIsImage: boolean | undefined;
    opacity: number;
    windowBarStyle: Platform;
}

const PlayerContainer = memo(
    ({
        children,
        dynamicBackground,
        dynamicIsImage,
        opacity,
        windowBarStyle,
    }: PlayerContainerProps) => {
        const currentSong = usePlayerSong();
        const imageUrl = useCachedItemImageUrl({
            id: currentSong?.albumId ?? currentSong?.imageId ?? undefined,
            imageUrl: currentSong?.imageUrl,
            itemType: LibraryItem.SONG,
            type: 'itemCard',
        });
        const { background } = useFastAverageColor({
            algorithm: 'dominant',
            src: imageUrl,
            srcLoaded: true,
        });

        return (
            <motion.div
                animate="open"
                className={styles.container}
                custom={{ background, dynamicBackground, windowBarStyle }}
                exit="closed"
                initial="closed"
                transition={{ duration: 2 }}
                variants={containerVariants}
            >
                <BackgroundImage
                    dynamicBackground={dynamicBackground}
                    dynamicIsImage={dynamicIsImage}
                />
                <BackgroundOverlay dynamicBackground={dynamicBackground} opacity={opacity} />
                {children}
            </motion.div>
        );
    },
);

PlayerContainer.displayName = 'PlayerContainer';

export const FullScreenPlayer = () => {
    // Leaf selectors — reading the whole fullscreen store re-rendered this on
    // every unrelated change (tab swap, opacity drag, visualizer toggle).
    const activeTab = useFullScreenPlayerActiveTab();
    const dynamicBackground = useFullScreenPlayerDynamicBackground();
    const dynamicImageBlur = useFullScreenPlayerDynamicImageBlur();
    const dynamicIsImage = useFullScreenPlayerDynamicIsImage();
    const opacity = useFullScreenPlayerOpacity();
    const { setStore } = useFullScreenPlayerStoreActions();
    const hasActiveModule =
        activeTab === 'queue' ||
        activeTab === 'related' ||
        activeTab === 'lyrics' ||
        activeTab === 'visualizer';

    const { windowBarStyle } = useWindowSettings();
    const isRadioActive = useIsRadioActive();
    const { isPlaying: isRadioPlaying } = useRadioPlayer();

    const isPlayingRadio = isRadioActive && isRadioPlaying;
    const effectiveDynamicBackground = dynamicBackground && !isPlayingRadio;

    const location = useLocation();
    const isOpenedRef = useRef<boolean | null>(null);

    useLayoutEffect(() => {
        if (isOpenedRef.current !== null) {
            setStore({ expanded: false });
        }

        isOpenedRef.current = true;
    }, [location, setStore]);

    return (
        <PlayerContainer
            dynamicBackground={effectiveDynamicBackground}
            dynamicIsImage={dynamicIsImage}
            opacity={opacity}
            windowBarStyle={windowBarStyle}
        >
            <Group
                className="full-screen-player-controls-container"
                gap="sm"
                p="0.5rem"
                pos="absolute"
                style={{
                    background: `rgb(var(--theme-colors-background-transparent))`,
                    left: 0,
                    top: 0,
                }}
            >
                <SharedFullscreenPlayerSettings />
            </Group>
            <BackgroundImageOverlay
                dynamicBackground={effectiveDynamicBackground}
                dynamicImageBlur={dynamicImageBlur}
            />
            <div className={styles.responsiveContainer}>
                <div
                    className={clsx(styles.imageColumn, {
                        [styles.imageColumnFull]: !hasActiveModule,
                    })}
                >
                    <FullScreenPlayerImage />
                </div>
                <FullScreenPlayerQueue />
            </div>
            <FullScreenPlayerControls />
        </PlayerContainer>
    );
};
