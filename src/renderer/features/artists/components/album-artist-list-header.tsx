import { useTranslation } from 'react-i18next';

import { useIsFetchingItemListCount } from '/@/renderer/components/item-list/helpers/use-is-fetching-item-list';
import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { useListContext } from '/@/renderer/context/list-context';
import { AlbumArtistListHeaderFilters } from '/@/renderer/features/artists/components/album-artist-list-header-filters';
import { useAlbumArtistListFilters } from '/@/renderer/features/artists/hooks/use-album-artist-list-filters';
import { useOfflineListSource } from '/@/renderer/features/context-menu/hooks/use-offline-download';
import { FilterBar } from '/@/renderer/features/shared/components/filter-bar';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { ListSearchInput } from '/@/renderer/features/shared/components/list-search-input';
import { Group } from '/@/shared/components/group/group';
import { Stack } from '/@/shared/components/stack/stack';
import { LibraryItem } from '/@/shared/types/domain-types';

interface AlbumArtistListHeaderProps {
    title?: string;
}

export const AlbumArtistListHeader = ({ title }: AlbumArtistListHeaderProps) => {
    const { t } = useTranslation();

    const pageTitle = title || t('page.albumArtistList.title');

    return (
        <Stack gap={0}>
            <PageHeader>
                <LibraryHeaderBar ignoreMaxWidth>
                    <PlayButton />
                    <LibraryHeaderBar.Title>{pageTitle}</LibraryHeaderBar.Title>
                    <AlbumArtistListHeaderBadge />
                    <OfflineButton />
                </LibraryHeaderBar>
                <Group>
                    <ListSearchInput />
                </Group>
            </PageHeader>
            <FilterBar>
                <AlbumArtistListHeaderFilters />
            </FilterBar>
        </Stack>
    );
};

const AlbumArtistListHeaderBadge = () => {
    const { itemCount } = useListContext();

    const isFetching = useIsFetchingItemListCount({
        itemType: LibraryItem.ALBUM_ARTIST,
    });

    return <LibraryHeaderBar.Badge isLoading={isFetching}>{itemCount}</LibraryHeaderBar.Badge>;
};

const PlayButton = () => {
    const { query } = useAlbumArtistListFilters();

    return <LibraryHeaderBar.PlayButton itemType={LibraryItem.ALBUM_ARTIST} listQuery={query} />;
};

const OfflineButton = () => {
    const { query } = useAlbumArtistListFilters();
    const { itemCount } = useListContext();
    const { available, getEntities } = useOfflineListSource(LibraryItem.ALBUM_ARTIST, query);

    if (!available) return null;

    return <LibraryHeaderBar.OfflineButton source={{ getEntities, itemCount, type: 'list' }} />;
};
