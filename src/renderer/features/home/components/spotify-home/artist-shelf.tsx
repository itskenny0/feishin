import { useTranslation } from 'react-i18next';

import { useAlbumArtistListQuery } from '/@/renderer/features/artists/queries/artists-queries';
import { EntityShelf } from '/@/renderer/features/home/components/spotify-home/entity-shelf';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId } from '/@/renderer/store';
import { AlbumArtistListSort, LibraryItem, SortOrder } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

const ARTIST_SHELF_LIMIT = 15;

/**
 * "Your favourite artists" shelf — circular artist covers. Data comes from
 * the shared `useAlbumArtistListQuery` sorted by play count (the artists the
 * user actually listens to), falling back to whatever the server returns
 * first. Renders nothing on an empty library (handled by EntityShelf).
 */
export const ArtistShelf = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();

    const { data, isLoading } = useAlbumArtistListQuery({
        query: {
            limit: ARTIST_SHELF_LIMIT,
            sortBy: AlbumArtistListSort.PLAY_COUNT,
            sortOrder: SortOrder.DESC,
            startIndex: 0,
        },
        serverId,
    });

    return (
        <EntityShelf
            isLoading={isLoading}
            isRound
            itemListKey={ItemListKey.ALBUM_ARTIST}
            items={data?.items ?? []}
            itemType={LibraryItem.ALBUM_ARTIST}
            showAllRoute={AppRoute.LIBRARY_ALBUM_ARTISTS}
            title={t('page.home.shelfArtists', { defaultValue: 'Your favourite artists' })}
        />
    );
};
