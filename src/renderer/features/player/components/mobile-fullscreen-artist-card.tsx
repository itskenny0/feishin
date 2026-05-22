import { useQuery } from '@tanstack/react-query';
import { memo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './mobile-fullscreen-player.module.css';

import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { artistsQueries } from '/@/renderer/features/artists/api/artists-api';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer, useSetFullScreenPlayerStore } from '/@/renderer/store';
import { sanitize } from '/@/renderer/utils/sanitize';
import { LibraryItem } from '/@/shared/types/domain-types';

interface MobileFullscreenArtistCardProps {
    artistId: string | undefined;
    artistName: string | undefined;
}

/**
 * Spotify-style "About the artist" card that lives below the player face
 * in the mobile fullscreen player's scroll surface.
 *
 * Pulls albumArtistDetail (image + biography) lazily — the query only
 * fires once the user scrolls down far enough that the card mounts, so
 * we don't punish first-load with an extra request. Renders nothing
 * when there's no artist (radio playback) and nothing once the data
 * resolves with no biography to display.
 */
export const MobileFullscreenArtistCard = memo(
    ({ artistId, artistName }: MobileFullscreenArtistCardProps) => {
        const { t } = useTranslation();
        const server = useCurrentServer();
        const setFullScreenPlayerStore = useSetFullScreenPlayerStore();

        const detailQuery = useQuery({
            ...artistsQueries.albumArtistDetail({
                query: { id: artistId ?? '' },
                serverId: server?.id,
            }),
            enabled: Boolean(server?.id && artistId),
        });

        // Two-layer "do we have a real portrait?" check. (1) Pre-emptive:
        // detailQuery.data.imageId is null on Jellyfin when ImageTags.Primary
        // is absent, so we can hide the card before mounting the <img>.
        // (2) Runtime: backends that always populate imageId (e.g.
        // Navidrome with a placeholder ID) need an onError fallback —
        // when the request 404s we mark the image as failed and hide
        // the card. imageFailedFor is keyed on artistId so changing the
        // currently-playing song resets the gate cleanly.
        const [imageFailedFor, setImageFailedFor] = useState<null | string>(null);
        useEffect(() => {
            // Reset on song-change so the next artist starts fresh.
            setImageFailedFor(null);
        }, [artistId]);

        const serverImageId = detailQuery.data?.imageId ?? null;
        const imageUrl = useItemImageUrl({
            id: artistId,
            itemType: LibraryItem.ALBUM_ARTIST,
            type: 'itemCard',
        });

        if (!artistId || !artistName) return null;
        if (detailQuery.isSuccess && !serverImageId) return null;
        if (imageFailedFor === artistId) return null;

        const biography = detailQuery.data?.biography;
        const albumCount = detailQuery.data?.albumCount;
        const songCount = detailQuery.data?.songCount;
        const stats = [
            albumCount ? t('entity.albumWithCount', { count: albumCount }) : null,
            songCount ? t('entity.trackWithCount', { count: songCount }) : null,
        ]
            .filter(Boolean)
            .join(' • ');

        const collapseFullScreen = () => setFullScreenPlayerStore({ expanded: false });
        const artistHref = generatePath(AppRoute.LIBRARY_ALBUM_ARTISTS_DETAIL, {
            albumArtistId: artistId,
        });

        return (
            <div className={styles.artistCard}>
                <div className={styles.artistCardHeader}>
                    {t('page.fullscreenPlayer.aboutTheArtist', {
                        defaultValue: 'About the artist',
                    })}
                </div>
                <Link
                    className={styles.artistCardBodyLink}
                    onClick={collapseFullScreen}
                    to={artistHref}
                >
                    <div className={styles.artistCardBody}>
                        {imageUrl && (
                            <img
                                alt={artistName}
                                className={styles.artistCardImage}
                                loading="lazy"
                                onError={() => setImageFailedFor(artistId)}
                                src={imageUrl}
                            />
                        )}
                        <div className={styles.artistCardMeta}>
                            <div className={styles.artistCardName}>{artistName}</div>
                            {stats && <div className={styles.artistCardStats}>{stats}</div>}
                            {biography && (
                                <div
                                    className={styles.artistCardBio}
                                    // sanitize-html drops scripts and stray tags
                                    // from server-supplied biography text.
                                    dangerouslySetInnerHTML={{ __html: sanitize(biography) }}
                                />
                            )}
                        </div>
                    </div>
                </Link>
            </div>
        );
    },
);

MobileFullscreenArtistCard.displayName = 'MobileFullscreenArtistCard';
