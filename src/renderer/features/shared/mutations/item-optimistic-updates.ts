import { QueryClient } from '@tanstack/react-query';

import { queryKeys } from '/@/renderer/api/query-keys';
import { infiniteLoaderDataQueryKey } from '/@/renderer/components/item-list/helpers/item-list-infinite-loader';
import { LibraryItem } from '/@/shared/types/domain-types';

export type ItemPatch = { userFavorite: boolean } | { userRating: number };

export interface PreviousQueryData {
    data: unknown;
    queryKey: readonly unknown[];
}

// How the cached value under a query key holds items:
// 'detail' = the value is the item itself, 'pages' = infinite query pages of
// `{ items }`, anything else = the name of the array field holding the items.
type Surface = 'data' | 'detail' | 'items' | 'pages' | 'similarArtists' | 'songs';

const getSurfaces = (
    serverId: string,
    type: LibraryItem,
): Array<[queryKey: readonly unknown[], surface: Surface]> => {
    switch (type) {
        case LibraryItem.ALBUM:
            return [
                [queryKeys.albums.detail(serverId), 'detail'],
                [queryKeys.albums.list(serverId), 'items'],
                [queryKeys.albums.infiniteList(serverId), 'pages'],
                [['home', 'album'], 'pages'],
                [infiniteLoaderDataQueryKey(serverId, LibraryItem.ALBUM), 'data'],
            ];
        case LibraryItem.ALBUM_ARTIST:
            return [
                [queryKeys.albumArtists.detail(serverId), 'detail'],
                [queryKeys.albumArtists.info(serverId), 'similarArtists'],
                [queryKeys.albumArtists.list(serverId), 'items'],
                [queryKeys.albumArtists.infiniteList(serverId), 'pages'],
                [infiniteLoaderDataQueryKey(serverId, LibraryItem.ALBUM_ARTIST), 'data'],
            ];
        case LibraryItem.ARTIST:
            return [
                [queryKeys.artists.list(serverId), 'items'],
                [queryKeys.artists.infiniteList(serverId), 'pages'],
                [infiniteLoaderDataQueryKey(serverId, LibraryItem.ARTIST), 'data'],
            ];
        case LibraryItem.PLAYLIST_SONG:
        case LibraryItem.QUEUE_SONG:
        case LibraryItem.SONG:
            return [
                [queryKeys.albums.detail(serverId), 'songs'],
                [queryKeys.songs.detail(serverId), 'detail'],
                [queryKeys.playlists.songList(serverId), 'items'],
                [queryKeys.songs.list(serverId), 'items'],
                [queryKeys.albumArtists.topSongs(serverId), 'items'],
                [['home', 'song'], 'pages'],
            ];
        default:
            return [];
    }
};

/**
 * Optimistically merge `patch` (favorite / rating) into every cached query
 * that holds one of the given items. Returns the previous data of each
 * query that changed, for `restoreQueryData` on failure.
 */
export const applyItemOptimisticUpdates = (
    queryClient: QueryClient,
    serverId: string,
    itemIds: string[],
    type: LibraryItem,
    patch: ItemPatch,
): PreviousQueryData[] => {
    const ids = new Set(itemIds);

    // Returns null when nothing in the array matched, so unchanged caches
    // keep their identity.
    const patchArray = (items: undefined | { id: string }[]) => {
        let changed = false;
        const next = items?.map((item) => {
            if (!item || !ids.has(item.id)) return item;
            changed = true;
            return { ...item, ...patch };
        });
        return changed ? next : null;
    };

    const patchSurface = (prev: any, surface: Surface) => {
        if (surface === 'detail') return ids.has(prev.id) ? { ...prev, ...patch } : prev;

        if (surface === 'pages') {
            let changed = false;
            const pages = prev.pages?.map((page: any) => {
                const items = page && patchArray(page.items);
                if (!items) return page;
                changed = true;
                return { ...page, items };
            });
            return changed ? { ...prev, pages } : prev;
        }

        const items = patchArray(prev[surface]);
        return items ? { ...prev, [surface]: items } : prev;
    };

    const previous: PreviousQueryData[] = [];

    getSurfaces(serverId, type).forEach(([prefix, surface]) => {
        queryClient.getQueriesData({ queryKey: prefix }).forEach(([queryKey, data]) => {
            if (!data) return;
            const next = patchSurface(data, surface);
            if (next === data) return;
            previous.push({ data, queryKey });
            queryClient.setQueryData(queryKey, next);
        });
    });

    return previous;
};

export const restoreQueryData = (queryClient: QueryClient, previous: PreviousQueryData[]) => {
    previous.forEach(({ data, queryKey }) => queryClient.setQueryData(queryKey, data));
};
