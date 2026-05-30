import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';

import { useListContext } from '/@/renderer/context/list-context';
import {
    AlbumListView,
    OverrideAlbumListQuery,
} from '/@/renderer/features/albums/components/album-list-content';
import {
    AlbumArtistListView,
    OverrideAlbumArtistListQuery,
} from '/@/renderer/features/artists/components/album-artist-list-content';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import {
    OverrideSongListQuery,
    SongListView,
} from '/@/renderer/features/songs/components/song-list-content';
import { useListSettings } from '/@/renderer/store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface FavoritesContentProps {
    itemType: LibraryItem;
}

export const FavoritesContent = ({ itemType }: FavoritesContentProps) => {
    return (
        <AnimatedPage>
            <Suspense fallback={<Spinner container />}>
                {itemType === LibraryItem.ALBUM && <AlbumFavorites />}
                {itemType === LibraryItem.SONG && <SongFavorites />}
                {itemType === LibraryItem.ALBUM_ARTIST && <ArtistFavorites />}
            </Suspense>
        </AnimatedPage>
    );
};

const AlbumFavorites = () => {
    const { t } = useTranslation();
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.ALBUM);
    const { customFilters } = useListContext();

    const albumQuery: OverrideAlbumListQuery = {
        ...(customFilters as OverrideAlbumListQuery),
    };

    return (
        <AlbumListView
            display={display}
            emptyState={{
                description: t('emptyState.favoriteAlbumsDescription', {
                    defaultValue: 'Albums you favorite will appear here.',
                }),
                title: t('emptyState.favoriteAlbumsTitle', {
                    defaultValue: 'No favorite albums yet',
                }),
            }}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={albumQuery}
            pagination={pagination}
            table={table}
        />
    );
};

const SongFavorites = () => {
    const { t } = useTranslation();
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.SONG);
    const { customFilters } = useListContext();

    const songQuery: OverrideSongListQuery = {
        ...(customFilters as OverrideSongListQuery),
    };

    return (
        <SongListView
            display={display}
            emptyState={{
                description: t('emptyState.favoriteSongsDescription', {
                    defaultValue: 'Songs you favorite will appear here.',
                }),
                title: t('emptyState.favoriteSongsTitle', {
                    defaultValue: 'No favorite songs yet',
                }),
            }}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={songQuery}
            pagination={pagination}
            table={table}
        />
    );
};

const ArtistFavorites = () => {
    const { t } = useTranslation();
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.ARTIST);
    const { customFilters } = useListContext();

    const albumArtistQuery: OverrideAlbumArtistListQuery = {
        ...(customFilters as OverrideAlbumArtistListQuery),
    };

    return (
        <AlbumArtistListView
            display={display}
            emptyState={{
                description: t('emptyState.favoriteAlbumArtistsDescription', {
                    defaultValue: 'Album artists you favorite will appear here.',
                }),
                title: t('emptyState.favoriteAlbumArtistsTitle', {
                    defaultValue: 'No favorite album artists yet',
                }),
            }}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={albumArtistQuery}
            pagination={pagination}
            table={table}
        />
    );
};
