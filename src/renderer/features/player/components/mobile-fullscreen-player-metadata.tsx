import clsx from 'clsx';
import { t } from 'i18next';
import { memo, MouseEvent } from 'react';
import { generatePath, Link } from 'react-router';

import styles from './mobile-fullscreen-player.module.css';

import { triggerHaptic } from '/@/renderer/hooks/use-haptic';
import { AppRoute } from '/@/renderer/router/routes';
import { useSetFullScreenPlayerStore } from '/@/renderer/store';
import { ActionIcon } from '/@/shared/components/action-icon/action-icon';
import { Group } from '/@/shared/components/group/group';
import { Rating } from '/@/shared/components/rating/rating';
import { Separator } from '/@/shared/components/separator/separator';
import { TextTitle } from '/@/shared/components/text-title/text-title';
import { Text } from '/@/shared/components/text/text';
import { PlaybackSelectors } from '/@/shared/constants/playback-selectors';
import { QueueSong } from '/@/shared/types/domain-types';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

interface MobileFullscreenPlayerMetadataProps {
    currentSong?: QueueSong;
    onToggleFavorite: (e: MouseEvent<HTMLButtonElement>) => void;
    onUpdateRating: (rating: number) => void;
    radioArtist?: string;
    radioStationName?: string;
    radioTitle?: string;
    showRating?: boolean;
}

export const MobileFullscreenPlayerMetadata = memo(
    ({
        currentSong,
        onToggleFavorite,
        onUpdateRating,
        radioArtist,
        radioStationName,
        radioTitle,
        showRating,
    }: MobileFullscreenPlayerMetadataProps) => {
        const isRadio = radioTitle !== undefined || radioStationName !== undefined;
        const setFullScreenPlayerStore = useSetFullScreenPlayerStore();

        const title = isRadio ? radioTitle || radioStationName || 'Radio' : currentSong?.name;
        const artistsDisplay = isRadio
            ? radioArtist || radioStationName || '—'
            : currentSong?.artists?.map((a) => a.name).join(', ');
        const album = isRadio ? radioStationName || '—' : currentSong?.album;
        const container = currentSong?.container;
        const year = isPlausibleReleaseYear(currentSong?.releaseYear)
            ? currentSong?.releaseYear
            : null;
        const isFavorite = currentSong?.userFavorite;
        const rating = currentSong?.userRating;

        const hasMetadata = !isRadio && (container || year);

        // Resolve nav targets: when the user taps an artist or album in the
        // fullscreen player we want to close the overlay AND navigate to
        // that detail page (matches Spotify's behaviour). artists[0] is
        // the canonical link target if there are multiple - tapping into a
        // collaboration's first artist is the conventional pick.
        const primaryArtistId = !isRadio ? currentSong?.artists?.[0]?.id : undefined;
        const albumId = !isRadio ? currentSong?.albumId : undefined;
        const artistHref = primaryArtistId
            ? generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
                  albumArtistId: primaryArtistId,
              })
            : undefined;
        const albumHref = albumId
            ? generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId })
            : undefined;
        const collapseFullScreen = () => setFullScreenPlayerStore({ expanded: false });

        return (
            <div className={styles.metadataContainer}>
                <div className={styles.titleRow}>
                    <TextTitle
                        className={PlaybackSelectors.songTitle}
                        fw={700}
                        order={2}
                        ta="center"
                    >
                        {title || '—'}
                    </TextTitle>
                </div>
                {artistHref ? (
                    <Text
                        className={clsx(PlaybackSelectors.songArtist)}
                        component={Link}
                        isLink
                        onClick={collapseFullScreen}
                        size="md"
                        to={artistHref}
                        truncate
                    >
                        {artistsDisplay || '—'}
                    </Text>
                ) : (
                    <Text className={clsx(PlaybackSelectors.songArtist)} size="md" truncate>
                        {artistsDisplay || '—'}
                    </Text>
                )}
                {albumHref ? (
                    <Text
                        className={clsx(PlaybackSelectors.songAlbum)}
                        component={Link}
                        isLink
                        onClick={collapseFullScreen}
                        size="md"
                        to={albumHref}
                        truncate
                    >
                        {album || '—'}
                    </Text>
                ) : (
                    <Text className={clsx(PlaybackSelectors.songAlbum)} size="md" truncate>
                        {album || '—'}
                    </Text>
                )}
                {hasMetadata && (
                    <Group align="center" className={styles.metadataRow} gap="xs" wrap="nowrap">
                        {container && <Text size="xs">{container}</Text>}
                        {year && (
                            <>
                                {container && <Separator />}
                                <Text size="xs">{year}</Text>
                            </>
                        )}
                    </Group>
                )}
                {!isRadio && (
                    <Group align="center" className={styles.actionsRow} gap="xs">
                        <ActionIcon
                            aria-label={t('common.favorite', { defaultValue: 'Favorite' })}
                            aria-pressed={Boolean(isFavorite)}
                            icon="favorite"
                            iconProps={{
                                fill: isFavorite ? 'primary' : undefined,
                                size: 'md',
                            }}
                            onClick={(event) => {
                                // Celebratory success pattern only when
                                // adding — un-favouriting is a destructive
                                // action and shouldn't feel rewarding.
                                if (!isFavorite) triggerHaptic('success');
                                onToggleFavorite(event);
                            }}
                            size="sm"
                            variant="subtle"
                        />
                        {showRating && (
                            <Rating onChange={onUpdateRating} size="sm" value={rating || 0} />
                        )}
                    </Group>
                )}
            </div>
        );
    },
);

MobileFullscreenPlayerMetadata.displayName = 'MobileFullscreenPlayerMetadata';
