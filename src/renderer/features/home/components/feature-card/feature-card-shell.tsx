import type { PanInfo } from 'motion/react';

import { animate, motion, useMotionValue } from 'motion/react';
import { MouseEvent as ReactMouseEvent, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './feature-card-shell.module.css';

import { useCachedItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { ContextMenuController } from '/@/renderer/features/context-menu/context-menu-controller';
import { setFeatureCardHovered } from '/@/renderer/features/home/components/feature-card/hover-signal';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import { useHomeFeatureCardSongsPerCard } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

/**
 * Generic data shape every feature-card variant must provide. The shell only
 * cares about how to lay this out; each variant is responsible for sourcing
 * the songs + labels however it sees fit.
 */
export interface FeatureCardData {
    /** Optional song whose cover is used as the blurred backdrop. Defaults to songs[0]. */
    backgroundSong?: null | Song;
    /** Optional context line above the title — "Featured artist", "Time machine", … */
    eyebrow: string;
    isLoading: boolean;
    /** Sequential "next" within the candidate pool. When present the shell
     *  renders a right-arrow navigation overlay. */
    onNext?: () => void;
    /** Sequential "previous" within the candidate pool. */
    onPrev?: () => void;
    /** Optional reshuffle action — hides the button if absent. */
    onReshuffle?: () => void;
    /** Optional rotation dots — shown when count > 1. */
    rotationCount?: number;
    rotationIndex?: number;
    rotationPaused?: boolean;
    /** The 10 (or fewer) songs to display in the grid. */
    songs: Song[];
    /** Secondary label below the title. */
    subtitle?: string;
    /** Main hero text — artist name, "1987", "Recently played", … */
    title: string;
    /** Optional URL the title links to. */
    titleHref?: string;
}

const SongTile = ({
    onClick,
    onContextMenu,
    song,
}: {
    onClick: (song: Song) => void;
    onContextMenu: (e: ReactMouseEvent<HTMLButtonElement>, song: Song) => void;
    song: Song;
}) => {
    const imageUrl = useCachedItemImageUrl({
        id: song?.albumId ?? song?.imageId ?? undefined,
        imageUrl: song.imageUrl || undefined,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });

    return (
        <button
            className={styles.songTile}
            onClick={() => onClick(song)}
            onContextMenu={(e) => onContextMenu(e, song)}
            title={song.name}
            type="button"
        >
            <div className={styles.songCover}>
                {imageUrl ? (
                    <img alt="" loading="lazy" src={imageUrl} />
                ) : (
                    <div style={{ height: '100%', width: '100%' }} />
                )}
            </div>
            <span className={styles.songTitle}>{song.name}</span>
        </button>
    );
};

const SongTileSkeleton = () => (
    <div className={styles.songTile}>
        <div className={styles.songCover}>
            <Skeleton borderRadius="4px" height="100%" width="100%" />
        </div>
        <Skeleton height={12} width="80%" />
    </div>
);

interface FeatureCardShellProps {
    /** Optional pill rendered in the top-right corner — used by Surprise Me to
     *  show which sub-variant is currently displayed. */
    cornerBadge?: string;
    data: FeatureCardData;
    /** Suppress the rotation dot indicator. Surprise Me passes this so the
     *  inner variant's dots (counting items in its own pool) don't appear
     *  alongside the outer "1 of 9 variants" cycle. */
    hideRotationDots?: boolean;
}

export const FeatureCardShell = ({
    cornerBadge,
    data,
    hideRotationDots = false,
}: FeatureCardShellProps) => {
    const { t } = useTranslation();
    const { addToQueueByData } = usePlayer();
    const songsPerCard = useHomeFeatureCardSongsPerCard();

    const backgroundSong = data.backgroundSong ?? data.songs[0] ?? null;
    const backgroundImageUrl = useCachedItemImageUrl({
        id: backgroundSong?.albumId ?? backgroundSong?.imageId ?? undefined,
        imageUrl: backgroundSong?.imageUrl || undefined,
        itemType: LibraryItem.SONG,
        type: 'fullScreenPlayer',
    });

    const handlePlayAll = useCallback(() => {
        if (data.songs.length === 0) return;
        addToQueueByData(data.songs, Play.NOW);
    }, [addToQueueByData, data.songs]);

    const handlePlayFromSong = useCallback(
        (song: Song) => {
            if (data.songs.length === 0) return;
            addToQueueByData(data.songs, Play.NOW, song.id);
        },
        [addToQueueByData, data.songs],
    );

    // Right-click on a tile opens the standard song context menu (queue,
    // add-to-playlist, info, etc.) — same controller used by the library
    // views, so the menu items stay consistent. The `items` array carries
    // the clicked song so single-item actions target it; multi-select isn't
    // meaningful from a grid tile so we hand off just the one.
    const handleContextMenu = useCallback((e: ReactMouseEvent<HTMLButtonElement>, song: Song) => {
        e.preventDefault();
        e.stopPropagation();
        ContextMenuController.call({
            cmd: { items: [song], type: LibraryItem.SONG },
            event: e,
        });
    }, []);

    // Hover state is forwarded to a module-level signal that usePoolRotation
    // reads on every tick. Avoids prop drilling through every variant and
    // keeps Surprise Me's outer rotation honoring the same pause.
    const onMouseEnter = useCallback(() => setFeatureCardHovered(true), []);
    const onMouseLeave = useCallback(() => setFeatureCardHovered(false), []);
    const onFocusIn = useCallback(() => setFeatureCardHovered(true), []);
    const onFocusOut = useCallback(() => setFeatureCardHovered(false), []);

    // Belt-and-suspenders: if the shell unmounts mid-hover, clear the signal
    // so the next mount doesn't inherit a stale "paused" state.
    useEffect(() => {
        return () => setFeatureCardHovered(false);
    }, []);

    const showSkeleton = data.isLoading && data.songs.length === 0;
    const hasSongs = data.songs.length > 0;
    // After the fetch finishes with no results we want a visible cue rather
    // than a silently-empty grid — that ambiguity was the most common
    // 'doesn't load' complaint.
    const showNoSongsMessage = !data.isLoading && data.songs.length === 0;

    const titleNode = data.titleHref ? (
        <Link className={styles.artistName} to={data.titleHref}>
            {data.title}
        </Link>
    ) : (
        <span className={styles.artistName}>{data.title}</span>
    );

    /*
     * Spotify-style finger-tracking swipe to switch variants. Same
     * Motion-native drag pattern as the mini-player / fullscreen-player
     * cover swipe — the card stays attached to the finger, velocity +
     * offset on release decides commit-vs-snap-back. Disabled when
     * onPrev / onNext aren't wired (e.g. variants with only one item).
     */
    const cardRef = useRef<HTMLDivElement | null>(null);
    const swipeX = useMotionValue(0);
    const canDrag = Boolean(data.onPrev || data.onNext);
    const handleDragEnd = useCallback(
        (_event: unknown, info: PanInfo) => {
            const width = cardRef.current?.offsetWidth ?? 320;
            const commitOffset = width * 0.25;
            const flickVelocity = 500;
            const offset = info.offset.x;
            const velocity = info.velocity.x;
            const wantsNext = offset < -commitOffset || velocity < -flickVelocity;
            const wantsPrev = offset > commitOffset || velocity > flickVelocity;

            if (wantsNext && data.onNext) {
                triggerHaptic('selection');
                data.onNext();
            } else if (wantsPrev && data.onPrev) {
                triggerHaptic('selection');
                data.onPrev();
            }
            animate(swipeX, 0, {
                damping: 28,
                stiffness: 360,
                type: 'spring',
                velocity,
            });
        },
        [data, swipeX],
    );

    return (
        <motion.div
            className={styles.card}
            drag={canDrag ? 'x' : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={1}
            dragMomentum={false}
            onBlur={onFocusOut}
            onDragEnd={handleDragEnd}
            onFocus={onFocusIn}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
            ref={cardRef}
            style={{ x: swipeX }}
        >
            <div
                aria-hidden
                className={styles.blurredBackground}
                style={
                    backgroundImageUrl
                        ? { backgroundImage: `url(${backgroundImageUrl})` }
                        : undefined
                }
            />
            <div aria-hidden className={styles.scrim} />
            <div className={styles.content}>
                <div className={styles.songGrid}>
                    {showSkeleton ? (
                        Array.from({ length: songsPerCard }).map((_, idx) => (
                            <SongTileSkeleton key={idx} />
                        ))
                    ) : showNoSongsMessage ? (
                        <div className={styles.noSongs}>{t('page.home.featureCard_emptyGrid')}</div>
                    ) : (
                        data.songs
                            .slice(0, songsPerCard)
                            .map((song) => (
                                <SongTile
                                    key={song.id}
                                    onClick={handlePlayFromSong}
                                    onContextMenu={handleContextMenu}
                                    song={song}
                                />
                            ))
                    )}
                </div>
                <div className={styles.infoPane}>
                    <span className={styles.eyebrow}>{data.eyebrow}</span>
                    {titleNode}
                    {data.subtitle && <span className={styles.subtitle}>{data.subtitle}</span>}
                    <div className={styles.actions}>
                        <Button
                            disabled={!hasSongs}
                            leftSection={<Icon icon="mediaPlay" />}
                            onClick={handlePlayAll}
                            variant="filled"
                        >
                            {t('page.home.featureArtist_playAll')}
                        </Button>
                        {data.onReshuffle && (
                            <Button
                                aria-label={t('page.home.featureArtist_reshuffle')}
                                leftSection={<Icon icon="mediaShuffle" />}
                                onClick={data.onReshuffle}
                                variant="default"
                            >
                                {t('page.home.featureArtist_reshuffle')}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
            {cornerBadge && <div className={styles.cornerBadge}>{cornerBadge}</div>}
            {data.onPrev && (
                <button
                    aria-label={t('page.home.featureArtist_previous')}
                    className={`${styles.navArrow} ${styles.navArrowLeft}`}
                    onClick={data.onPrev}
                    type="button"
                >
                    <Icon icon="arrowLeftS" size="xl" />
                </button>
            )}
            {data.onNext && (
                <button
                    aria-label={t('page.home.featureArtist_next')}
                    className={`${styles.navArrow} ${styles.navArrowRight}`}
                    onClick={data.onNext}
                    type="button"
                >
                    <Icon icon="arrowRightS" size="xl" />
                </button>
            )}
            {!hideRotationDots && data.rotationCount && data.rotationCount > 1 && (
                <div
                    aria-hidden
                    className={styles.dots}
                    title={
                        data.rotationPaused
                            ? t('page.home.featureArtist_paused')
                            : t('page.home.featureArtist_rotating')
                    }
                >
                    {Array.from({ length: Math.min(data.rotationCount, 5) }).map((_, idx) => (
                        <span
                            className={`${styles.dot}${
                                idx ===
                                (data.rotationIndex ?? 0) % Math.min(data.rotationCount ?? 1, 5)
                                    ? ` ${styles.dotActive}`
                                    : ''
                            }`}
                            key={idx}
                        />
                    ))}
                </div>
            )}
        </motion.div>
    );
};
