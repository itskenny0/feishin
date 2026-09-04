import clsx from 'clsx';
import { AnimatePresence, HTMLMotionProps, motion, Variants } from 'motion/react';
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './full-screen-player-image.module.css';

import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { useActiveNowPlayingItem } from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { SharedFullscreenPlayerMetadata } from '/@/renderer/features/player/components/shared-full-screen-player-metadata';
import { useCrossfadeImageSlots } from '/@/renderer/features/player/hooks/use-crossfade-image-slots';
import {
    useIsRadioActive,
    useRadioPlayer,
} from '/@/renderer/features/radio/hooks/use-radio-player';
import {
    PlayerItem,
    useBlurExplicitImages,
    useFullScreenPlayerStore,
    useNativeAspectRatio,
    usePlayerData,
    usePlayerItems,
} from '/@/renderer/store';
import { formatPartialIsoDateUTC } from '/@/renderer/utils';
import { Badge } from '/@/shared/components/badge/badge';
import { Center } from '/@/shared/components/center/center';
import { Flex } from '/@/shared/components/flex/flex';
import { Icon } from '/@/shared/components/icon/icon';
import { ExplicitStatus, LibraryItem, QueueSong } from '/@/shared/types/domain-types';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

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
    explicit,
    placeholderIcon = 'itemAlbum',
    ...props
}: HTMLMotionProps<'img'> & {
    explicit?: boolean;
    placeholder?: string;
    placeholderIcon?: 'itemAlbum' | 'radio';
}) => {
    const nativeAspectRatio = useNativeAspectRatio();

    if (!props.src) {
        return (
            <Center
                style={{
                    background: 'var(--theme-colors-surface)',
                    borderRadius: 'var(--theme-card-default-radius)',
                    height: '100%',
                    width: '100%',
                }}
            >
                <Icon color="muted" icon={placeholderIcon} size="25%" />
            </Center>
        );
    }

    return (
        <MotionImage
            className={clsx(styles.image, className, {
                [styles.censored]: explicit,
            })}
            style={{
                objectFit: nativeAspectRatio ? 'contain' : 'cover',
                width: nativeAspectRatio ? 'auto' : '100%',
            }}
            {...props}
        />
    );
};

export const FullScreenPlayerImage = () => {
    const { t } = useTranslation();
    const mainImageRef = useRef<HTMLImageElement | null>(null);
    const [imageContainerWidth, setImageContainerWidth] = useState<null | number>(null);

    const isRadioActive = useIsRadioActive();
    const { isPlaying: isRadioPlaying } = useRadioPlayer();

    // Active source: mirrors the remote device's now-playing when a Jellyfin
    // Connect target is selected (identical to the local song otherwise). The
    // mirrored Song has no _uniqueId, so the crossfade key falls back to id.
    const currentSong = useActiveNowPlayingItem();
    const songKey = (currentSong as null | QueueSong)?._uniqueId ?? currentSong?.id;
    const { nextSong } = usePlayerData();
    const blurExplicitImages = useBlurExplicitImages();
    const playerItems = usePlayerItems();
    const { coverArtSize, titleDisplayType, titleLineCount } = useFullScreenPlayerStore();

    const isPlayingRadio = isRadioActive && isRadioPlaying;

    // Cache-first, keyed on albumId: the sweep caches covers by album, and on
    // Subsonic/Navidrome a song's imageId is the coverArt id, not the album id.
    const currentImageUrl = useCachedItemImageUrl({
        id: currentSong?.albumId ?? currentSong?.imageId ?? undefined,
        itemType: LibraryItem.SONG,
        serverId: currentSong?._serverId,
        type: 'fullScreenPlayer',
    });

    const nextImageUrl = useCachedItemImageUrl({
        id: nextSong?.albumId ?? nextSong?.imageId ?? undefined,
        itemType: LibraryItem.SONG,
        serverId: nextSong?._serverId,
        type: 'fullScreenPlayer',
    });

    const imageState = useCrossfadeImageSlots({
        currentExplicit: currentSong?.explicitStatus === ExplicitStatus.EXPLICIT,
        currentImageUrl,
        nextExplicit: nextSong?.explicitStatus === ExplicitStatus.EXPLICIT,
        nextImageUrl,
        paused: isPlayingRadio,
        songKey,
    });

    const isItemEnabled = (item: PlayerItem) =>
        !playerItems.find((entry) => entry.id === item)?.disabled;
    const showTitle = isItemEnabled(PlayerItem.TITLE);
    const showArtist = isItemEnabled(PlayerItem.ARTIST);
    const showAlbum = isItemEnabled(PlayerItem.ALBUM);

    const builtDataItems = {
        bit_depth: currentSong?.bitDepth && <Badge>{currentSong?.bitDepth} bit</Badge>,
        bit_rate: currentSong?.bitRate && <Badge>{currentSong?.bitRate} kbps</Badge>,
        bpm: currentSong?.bpm && (
            <Badge>
                {currentSong?.bpm} {t('common.bpm')}
            </Badge>
        ),
        codec: currentSong?.container && <Badge>{currentSong?.container}</Badge>,
        date: currentSong?.date && <Badge>{formatPartialIsoDateUTC(currentSong?.date)}</Badge>,
        disc_number: currentSong?.discNumber && (
            <Badge>
                {t('common.disc')} {currentSong?.discNumber}
            </Badge>
        ),
        genres:
            currentSong?.genres &&
            currentSong?.genres
                .slice(0, 2)
                .map((genre) => <Badge key={genre.id}>{genre.name}</Badge>),
        release_date: currentSong?.releaseDate && (
            <Badge>{formatPartialIsoDateUTC(currentSong?.releaseDate)}</Badge>
        ),
        release_type: currentSong?.tags?.releasetype && (
            <Badge>{currentSong?.tags?.releasetype[0]}</Badge>
        ),
        release_year: isPlausibleReleaseYear(currentSong?.releaseYear) && (
            <Badge>{currentSong?.releaseYear}</Badge>
        ),
        sample_rate: currentSong?.sampleRate && <Badge>{currentSong?.sampleRate / 1000} kHz</Badge>,
        track_number: currentSong?.trackNumber && (
            <Badge>
                {t('common.trackNumber')} {currentSong?.trackNumber}
            </Badge>
        ),
        year: currentSong?.year && <Badge>{currentSong?.year}</Badge>,
    };

    const showMetadata =
        playerItems.some((i) => !i.disabled && builtDataItems[i.id]) ||
        showTitle ||
        showArtist ||
        showAlbum;

    useLayoutEffect(() => {
        const updateImageContainerWidth = () => {
            if (mainImageRef.current) {
                const width = mainImageRef.current.getBoundingClientRect().width;
                setImageContainerWidth(width);
            }
        };

        updateImageContainerWidth();
        window.addEventListener('resize', updateImageContainerWidth);

        return () => window.removeEventListener('resize', updateImageContainerWidth);
    }, []);

    useLayoutEffect(() => {
        const updateImageContainerWidth = () => {
            if (mainImageRef.current) {
                const width = mainImageRef.current.getBoundingClientRect().width;
                setImageContainerWidth(width);
            }
        };

        updateImageContainerWidth();
    }, [titleDisplayType, titleLineCount, coverArtSize]);

    return (
        <Flex
            align="center"
            className={clsx(styles.playerContainer, 'full-screen-player-image-container')}
            direction="column"
            h="100%"
            justify="center"
            p="1rem"
            w="100%"
        >
            <div
                className={styles.imageContainer}
                ref={mainImageRef}
                style={{
                    marginBottom: showMetadata ? '2rem' : undefined,
                    maxHeight: `${coverArtSize}%`,
                }}
            >
                <AnimatePresence initial={false} mode="sync">
                    {!isPlayingRadio && imageState.current === 0 && (
                        <ImageWithPlaceholder
                            animate="open"
                            className="full-screen-player-image"
                            custom={{ isOpen: imageState.current === 0 }}
                            draggable={false}
                            exit="closed"
                            explicit={blurExplicitImages && imageState.topExplicit}
                            initial="closed"
                            // Slot-stable key (not song-derived): only the active slot
                            // renders and the crossfade fires on the imageState flip, so
                            // a song-keyed key would spawn a spurious same-image
                            // transition before the hook's flip lands.
                            key="crossfade-top"
                            placeholder="var(--theme-colors-foreground-muted)"
                            src={imageState.topImage || ''}
                            variants={imageVariants}
                        />
                    )}

                    {!isPlayingRadio && imageState.current === 1 && (
                        <ImageWithPlaceholder
                            animate="open"
                            className="full-screen-player-image"
                            custom={{ isOpen: imageState.current === 1 }}
                            draggable={false}
                            exit="closed"
                            explicit={blurExplicitImages && imageState.bottomExplicit}
                            initial="closed"
                            key="crossfade-bottom"
                            placeholder="var(--theme-colors-foreground-muted)"
                            src={imageState.bottomImage || ''}
                            variants={imageVariants}
                        />
                    )}

                    {isPlayingRadio && (
                        <ImageWithPlaceholder
                            animate="open"
                            className="full-screen-player-image"
                            custom={{ isOpen: true }}
                            draggable={false}
                            exit="closed"
                            initial="closed"
                            key="radio"
                            placeholder="var(--theme-colors-foreground-muted)"
                            placeholderIcon="radio"
                            src=""
                            variants={imageVariants}
                        />
                    )}
                </AnimatePresence>
            </div>
            <SharedFullscreenPlayerMetadata imageContainerWidth={imageContainerWidth} />
        </Flex>
    );
};
