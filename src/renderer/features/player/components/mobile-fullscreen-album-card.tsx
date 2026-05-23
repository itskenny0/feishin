import { useQuery } from '@tanstack/react-query';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { generatePath, Link } from 'react-router';

import styles from './mobile-fullscreen-player.module.css';

import { CachedImage } from '/@/renderer/cache';
import { useItemImageUrl } from '/@/renderer/components/item-image/item-image';
import { albumQueries } from '/@/renderer/features/albums/api/album-api';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServer, useSetFullScreenPlayerStore } from '/@/renderer/store';
import { LibraryItem } from '/@/shared/types/domain-types';

interface MobileFullscreenAlbumCardProps {
    albumId: string | undefined;
    albumName: string | undefined;
}

/**
 * Compact "From the album" card below the lyrics card in the mobile
 * fullscreen player stack. Mirrors the about-artist card but trimmed
 * down — Spotify's pattern is a tiny row card here, not a hero with
 * biography. Shows the cover, album name, artist, and year if the
 * server returned it. The whole card links to the album detail page;
 * the link also collapses the fullscreen player so the user lands on
 * the album view directly instead of underneath the overlay.
 */
export const MobileFullscreenAlbumCard = memo(
    ({ albumId, albumName }: MobileFullscreenAlbumCardProps) => {
        const { t } = useTranslation();
        const server = useCurrentServer();
        const setFullScreenPlayerStore = useSetFullScreenPlayerStore();

        const detailQuery = useQuery({
            ...albumQueries.detail({
                query: { id: albumId ?? '' },
                serverId: server?.id,
            }),
            enabled: Boolean(server?.id && albumId),
        });

        const imageUrl = useItemImageUrl({
            id: albumId,
            itemType: LibraryItem.ALBUM,
            type: 'itemCard',
        });

        if (!albumId || !albumName) return null;

        const artistLine = detailQuery.data?.albumArtists?.map((a) => a.name).join(', ');
        const year = detailQuery.data?.releaseYear;
        const subtitle = [artistLine, year].filter(Boolean).join(' • ');

        const collapseFullScreen = () => setFullScreenPlayerStore({ expanded: false });
        const albumHref = generatePath(AppRoute.LIBRARY_ALBUMS_DETAIL, { albumId });

        return (
            <div className={styles.albumCard}>
                <div className={styles.albumCardHeader}>
                    {t('page.fullscreenPlayer.fromTheAlbum', {
                        defaultValue: 'From the album',
                    })}
                </div>
                <Link
                    className={styles.albumCardBodyLink}
                    onClick={collapseFullScreen}
                    to={albumHref}
                >
                    <div className={styles.albumCardBody}>
                        {imageUrl && albumId ? (
                            <CachedImage
                                alt={albumName}
                                className={styles.albumCardImage}
                                itemId={albumId}
                                loading="lazy"
                                size={96}
                                src={imageUrl}
                            />
                        ) : imageUrl ? (
                            <img
                                alt={albumName}
                                className={styles.albumCardImage}
                                loading="lazy"
                                src={imageUrl}
                            />
                        ) : (
                            <div className={styles.albumCardImagePlaceholder} />
                        )}
                        <div className={styles.albumCardMeta}>
                            <div className={styles.albumCardName}>{albumName}</div>
                            {subtitle && <div className={styles.albumCardSubtitle}>{subtitle}</div>}
                        </div>
                    </div>
                </Link>
            </div>
        );
    },
);

MobileFullscreenAlbumCard.displayName = 'MobileFullscreenAlbumCard';
