import { Suspense, useMemo } from 'react';
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
import { EmptyState, EmptyStateProps } from '/@/renderer/features/shared/components/empty-state';
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
    const [searchParams] = useSearchParams();
    const searchTerm = searchParams.get('query') || '';

    // With no query the dedicated /search page would otherwise dump the
    // entire alphabetical library, which reads as a redundant library list
    // and hides what the page is for. Show a prompt instead until the user
    // types. (Applies to every tab.)
    if (searchTerm.length === 0) {
        return (
            <AnimatedPage>
                <SearchPrompt />
            </AnimatedPage>
        );
    }

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

const SearchPrompt = () => {
    const { t } = useTranslation();
    return (
        <EmptyState
            description={t('emptyState.searchPromptDescription', {
                defaultValue: 'Find songs, albums, and artists.',
            })}
            icon="search"
            title={t('emptyState.searchPromptTitle', { defaultValue: 'Search your library' })}
        />
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

    // Stable reference — AlbumListView memoizes its merged query against
    // this object's identity. A fresh literal each render thrashes the
    // memo and refetches every keystroke.
    const albumQuery = useMemo<OverrideAlbumListQuery>(
        () => ({
            searchTerm,
            sortBy: AlbumListSort.NAME,
            sortOrder: SortOrder.ASC,
        }),
        [searchTerm],
    );

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

    const songQuery = useMemo<OverrideSongListQuery>(
        () => ({
            searchTerm,
            sortBy: SongListSort.NAME,
            sortOrder: SortOrder.ASC,
        }),
        [searchTerm],
    );

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
    const searchTerm = searchParams.get('query') || '';
    const emptyState = useSearchEmptyState(searchTerm.length > 0);

    const albumArtistQuery = useMemo<OverrideAlbumArtistListQuery>(
        () => ({
            searchTerm,
            sortBy: AlbumArtistListSort.NAME,
            sortOrder: SortOrder.ASC,
        }),
        [searchTerm],
    );

    // AlbumArtistListView runs its own limit-1 count probe and renders the
    // supplied emptyState when the result set is empty, so we just hand it the
    // "no results" state — same as AlbumSearch / SongSearch.
    return (
        <AlbumArtistListView
            display={display}
            emptyState={emptyState}
            grid={grid}
            itemsPerPage={itemsPerPage}
            overrideQuery={albumArtistQuery}
            pagination={pagination}
            table={table}
        />
    );
};
