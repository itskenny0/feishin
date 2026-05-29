import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useIsFetchingItemListCount } from '/@/renderer/components/item-list/helpers/use-is-fetching-item-list';
import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { useListContext } from '/@/renderer/context/list-context';
import { AlbumListHeaderFilters } from '/@/renderer/features/albums/components/album-list-header-filters';
import { useAlbumListFilters } from '/@/renderer/features/albums/hooks/use-album-list-filters';
import { artistsQueries } from '/@/renderer/features/artists/api/artists-api';
import { useOfflineListSource } from '/@/renderer/features/context-menu/hooks/use-offline-download';
import { useGenreList } from '/@/renderer/features/genres/api/genres-api';
import { FilterBar } from '/@/renderer/features/shared/components/filter-bar';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { ListSearchInput } from '/@/renderer/features/shared/components/list-search-input';
import { useCurrentServerId } from '/@/renderer/store';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { LibraryItem } from '/@/shared/types/domain-types';
import { ItemListKey } from '/@/shared/types/types';

interface AlbumListHeaderProps {
    title?: string;
}

export const AlbumListHeader = ({ title }: AlbumListHeaderProps) => {
    return (
        <Stack gap={0}>
            <PageHeader>
                <LibraryHeaderBar ignoreMaxWidth>
                    <PlayButton />
                    <PageTitle title={title} />
                    <AlbumListHeaderBadge />
                    <OfflineButton />
                </LibraryHeaderBar>
                <Group>
                    <ListSearchInput />
                </Group>
            </PageHeader>
            <FilterBar>
                <AlbumListHeaderFilters />
            </FilterBar>
        </Stack>
    );
};

const AlbumListHeaderBadge = () => {
    const { itemCount } = useListContext();

    const isFetching = useIsFetchingItemListCount({
        itemType: LibraryItem.ALBUM,
    });

    return <LibraryHeaderBar.Badge isLoading={isFetching}>{itemCount}</LibraryHeaderBar.Badge>;
};

const PageTitle = ({ title }: { title?: string }) => {
    const { t } = useTranslation();
    const { pageKey } = useListContext();
    const pageTitle = title || t('page.albumList.title');

    switch (pageKey) {
        case ItemListKey.ALBUM_ARTIST_ALBUM:
            return (
                <Suspense fallback={<LibraryHeaderBar.Title>—</LibraryHeaderBar.Title>}>
                    <AlbumArtistTitle />
                </Suspense>
            );
        case ItemListKey.GENRE_ALBUM:
            return (
                <Suspense fallback={<LibraryHeaderBar.Title>—</LibraryHeaderBar.Title>}>
                    <GenreTitle />
                </Suspense>
            );
    }

    return <LibraryHeaderBar.Title>{pageTitle}</LibraryHeaderBar.Title>;
};

const GenreTitle = () => {
    const { id } = useListContext();
    const { data: genres } = useGenreList();

    const name = useMemo(() => {
        return genres?.items.find((g) => g.id === id)?.name || '—';
    }, [id, genres]);

    return <LibraryHeaderBar.Title>{name}</LibraryHeaderBar.Title>;
};

const AlbumArtistTitle = () => {
    const serverId = useCurrentServerId();
    const { id } = useListContext();

    const { data: albumArtist } = useSuspenseQuery(
        artistsQueries.albumArtistDetail({
            query: { id: id! },
            serverId: serverId,
        }),
    );

    return <LibraryHeaderBar.Title>{albumArtist?.name || '—'}</LibraryHeaderBar.Title>;
};

const useMergedQuery = () => {
    const { query } = useAlbumListFilters();
    const { customFilters } = useListContext();

    return useMemo(() => {
        return {
            ...query,
            ...(customFilters ?? {}),
        };
    }, [query, customFilters]);
};

const PlayButton = () => {
    const mergedQuery = useMergedQuery();

    return (
        <LibraryHeaderBar.PlayButton
            itemType={LibraryItem.ALBUM}
            listQuery={mergedQuery}
            variant="filled"
        />
    );
};

const OfflineButton = () => {
    const mergedQuery = useMergedQuery();
    const { itemCount } = useListContext();
    const { available, getEntities } = useOfflineListSource(LibraryItem.ALBUM, mergedQuery);

    if (!available) return null;

    return <LibraryHeaderBar.OfflineButton source={{ getEntities, itemCount, type: 'list' }} />;
};
