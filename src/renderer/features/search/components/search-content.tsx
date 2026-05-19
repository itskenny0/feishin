import { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useParams, useSearchParams } from 'react-router';

import {
    AlbumListView,
    OverrideAlbumListQuery,
} from '/@/renderer/features/albums/components/album-list-content';
import {
    AlbumArtistListView,
    OverrideAlbumArtistListQuery,
} from '/@/renderer/features/artists/components/album-artist-list-content';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
import {
    OverrideSongListQuery,
    SongListView,
} from '/@/renderer/features/songs/components/song-list-content';
import { useListSettings } from '/@/renderer/store';
import { Spinner } from '/@/shared/components/spinner/spinner';
import {
    AlbumArtistListSort,
    AlbumListSort,
    LibraryItem,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

export const SearchContent = () => {
    const { itemType } = useParams() as { itemType: LibraryItem };

    return (
        <AnimatedPage>
            <Suspense fallback={<Spinner container />}>
                {itemType === LibraryItem.ALBUM && <AlbumSearch />}
                {itemType === LibraryItem.SONG && <SongSearch />}
                {itemType === LibraryItem.ALBUM_ARTIST && <ArtistSearch />}
            </Suspense>
        </AnimatedPage>
    );
};

const useSearchEmptyState = (active: boolean): EmptyStateProps | undefined => {
    const { t } = useTranslation();
    if (!active) {
        return undefined;
    }
    return {
        description: t('emptyState.searchDescription', {
            defaultValue: "We couldn't find anything matching that search.",
        }),
        icon: 'search',
        title: t('emptyState.searchTitle', { defaultValue: 'No results' }),
    };
};

const AlbumSearch = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.ALBUM);
    const [searchParams] = useSearchParams();
    const searchTerm = searchParams.get('query') || '';
    const emptyState = useSearchEmptyState(searchTerm.length > 0);

    const albumQuery: OverrideAlbumListQuery = {
        searchTerm,
        sortBy: AlbumListSort.NAME,
        sortOrder: SortOrder.ASC,
    };

    return (
        <AlbumListView
            display={display}
            emptyState={emptyState}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={albumQuery}
            pagination={pagination}
            table={table}
        />
    );
};

const SongSearch = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.SONG);
    const [searchParams] = useSearchParams();
    const searchTerm = searchParams.get('query') || '';
    const emptyState = useSearchEmptyState(searchTerm.length > 0);

    const songQuery: OverrideSongListQuery = {
        searchTerm,
        sortBy: SongListSort.NAME,
        sortOrder: SortOrder.ASC,
    };

    return (
        <SongListView
            display={display}
            emptyState={emptyState}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={songQuery}
            pagination={pagination}
            table={table}
        />
    );
};

const ArtistSearch = () => {
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(ItemListKey.ARTIST);
    const [searchParams] = useSearchParams();

    const albumArtistQuery: OverrideAlbumArtistListQuery = {
        searchTerm: searchParams.get('query') || '',
        sortBy: AlbumArtistListSort.NAME,
        sortOrder: SortOrder.ASC,
    };

    return (
        <AlbumArtistListView
            display={display}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={albumArtistQuery}
            pagination={pagination}
            table={table}
        />
    );
};
