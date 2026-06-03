import { Suspense, useEffect } from 'react';
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
import { useAlbumArtistListQuery } from '/@/renderer/features/artists/queries/artists-queries';
import {
    ListGridSkeleton,
    ListTableSkeleton,
} from '/@/renderer/features/shared/components/list-skeleton';
import {
    OverrideSongListQuery,
    SongListView,
} from '/@/renderer/features/songs/components/song-list-content';
import { useCurrentServer, useListSettings } from '/@/renderer/store';
import { AlbumArtistListQuery, LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey, ListDisplayType } from '/@/shared/types/types';

interface FavoritesContentProps {
    itemType: LibraryItem;
}

/**
 * Display-aware Suspense fallback shared by all three favorites views.
 *
 * The previous generic `<Spinner container />` painted a centered spinner that
 * bore no resemblance to the content about to land, so the swap to the
 * virtualized grid/table caused a visible jump. These skeletons mirror the
 * library list routes (album/song/artist list-content) — a column-matched grid
 * of cover cards or a compact table of rows at the real row height — so the
 * favorites content area resolves with zero layout shift.
 */
const FavoritesFallback = ({ itemType }: { itemType: LibraryItem }) => {
    const settingsKey =
        itemType === LibraryItem.ALBUM
            ? ItemListKey.ALBUM
            : itemType === LibraryItem.ALBUM_ARTIST
              ? ItemListKey.ALBUM_ARTIST
              : ItemListKey.SONG;

    const { display, grid, table } = useListSettings(settingsKey);

    if (display === ListDisplayType.TABLE) {
        return <ListTableSkeleton enableHeader={table.enableHeader} size={table.size} />;
    }

    return (
        <ListGridSkeleton
            circular={itemType === LibraryItem.ALBUM_ARTIST}
            columns={grid.itemsPerRowEnabled ? grid.itemsPerRow : undefined}
            gap={grid.itemGap}
            rows={itemType === LibraryItem.ALBUM ? 2 : 1}
            size={grid.size}
        />
    );
};

export const FavoritesContent = ({ itemType }: FavoritesContentProps) => {
    return (
        <Suspense fallback={<FavoritesFallback itemType={itemType} />}>
            {itemType === LibraryItem.ALBUM && <AlbumFavorites />}
            {itemType === LibraryItem.SONG && <SongFavorites />}
            {itemType === LibraryItem.ALBUM_ARTIST && <ArtistFavorites />}
        </Suspense>
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
                icon: 'favorite',
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
                icon: 'favorite',
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
    // The favorites flow keys the whole page (route pageKey + header dropdown)
    // on ItemListKey.ALBUM_ARTIST, so the content view must read its display /
    // grid / table settings from the SAME bucket — otherwise toggling display
    // here reads/writes a different settings slice than the rest of the page.
    const { display, grid, itemsPerPage, pagination, table } = useListSettings(
        ItemListKey.ALBUM_ARTIST,
    );
    const { customFilters, setItemCount } = useListContext();
    const server = useCurrentServer();

    const albumArtistQuery: OverrideAlbumArtistListQuery = {
        ...(customFilters as OverrideAlbumArtistListQuery),
    };

    // AlbumArtistListView (unlike the album/song views) never reports its count
    // back through setItemCount, so the header badge would spin forever on the
    // artist tab. Probe the count at the feature level (cheap limit-1 query,
    // de-duped against the list's own count probe) and push it into context.
    const countQuery = useAlbumArtistListQuery({
        query: { ...albumArtistQuery, limit: 1, startIndex: 0 } as AlbumArtistListQuery,
        serverId: server.id,
    });

    const count = countQuery.data?.totalRecordCount;

    useEffect(() => {
        if (count != null) setItemCount?.(count);
    }, [count, setItemCount]);

    return (
        <AlbumArtistListView
            display={display}
            emptyState={{
                description: t('emptyState.favoriteAlbumArtistsDescription', {
                    defaultValue: 'Album artists you favorite will appear here.',
                }),
                icon: 'favorite',
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
