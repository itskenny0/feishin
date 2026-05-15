import { useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import styles from './feature-card-shell.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { setFeatureCardHovered } from '/@/renderer/features/home/components/feature-card/hover-signal';
import { usePlayer } from '/@/renderer/features/player/context/player-context';
import { Button } from '/@/shared/components/button/button';
import { Icon } from '/@/shared/components/icon/icon';
import { Skeleton } from '/@/shared/components/skeleton/skeleton';
import { LibraryItem, Song } from '/@/shared/types/domain-types';
import { Play } from '/@/shared/types/types';

export const SONGS_PER_CARD = 10;
export const ROTATE_INTERVAL_MS = 30_000;

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

const SongTile = ({ onClick, song }: { onClick: (song: Song) => void; song: Song }) => {
    const imageUrl = useItemImageUrl({
        id: song.imageId || undefined,
        imageUrl: song.imageUrl || undefined,
        itemType: LibraryItem.SONG,
        type: 'itemCard',
    });

    return (
        <button
            className={styles.songTile}
            onClick={() => onClick(song)}
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

    const backgroundSong = data.backgroundSong ?? data.songs[0] ?? null;
    const backgroundImageUrl = useItemImageUrl({
        id: backgroundSong?.imageId || undefined,
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

    return (
        <div
            className={styles.card}
            onBlur={onFocusOut}
            onFocus={onFocusIn}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
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
                        Array.from({ length: SONGS_PER_CARD }).map((_, idx) => (
                            <SongTileSkeleton key={idx} />
                        ))
                    ) : showNoSongsMessage ? (
                        <div className={styles.noSongs}>{t('page.home.featureCard_emptyGrid')}</div>
                    ) : (
                        data.songs
                            .slice(0, SONGS_PER_CARD)
                            .map((song) => (
                                <SongTile key={song.id} onClick={handlePlayFromSong} song={song} />
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
        </div>
    );
};
