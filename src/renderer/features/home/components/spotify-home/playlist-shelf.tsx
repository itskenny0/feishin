import { useTranslation } from 'react-i18next';

import { EntityShelf } from '/@/renderer/features/home/components/spotify-home/entity-shelf';
import { usePlaylistListQuery } from '/@/renderer/features/playlists/queries/playlists-queries';
import { AppRoute } from '/@/renderer/router/routes';
import { useCurrentServerId } from '/@/renderer/store';
import { LibraryItem, PlaylistListSort, SortOrder } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

const PLAYLIST_SHELF_LIMIT = 15;

/**
 * "Your playlists" shelf — rounded-square playlist covers. Data from the
 * shared `usePlaylistListQuery` sorted by most-recently-updated so the
 * playlists the user is actively curating surface first. Collapses to
 * nothing when the user has no playlists.
 */
export const PlaylistShelf = () => {
    const { t } = useTranslation();
    const serverId = useCurrentServerId();

    const { data, isLoading } = usePlaylistListQuery({
        query: {
            limit: PLAYLIST_SHELF_LIMIT,
            sortBy: PlaylistListSort.UPDATED_AT,
            sortOrder: SortOrder.DESC,
            startIndex: 0,
        },
        serverId,
    });

    return (
        <EntityShelf
            isLoading={isLoading}
            itemListKey={ItemListKey.PLAYLIST}
            items={data?.items ?? []}
            itemType={LibraryItem.PLAYLIST}
            showAllRoute={AppRoute.PLAYLISTS}
            title={t('page.home.shelfPlaylists', { defaultValue: 'Your playlists' })}
        />
    );
};
