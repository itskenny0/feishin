// Write-through for the list loaders' network pages. The infinite /
// paginated loaders fetch raw `{ items }` pages via the per-entity
// controller calls but historically never persisted them — only the
// per-feature cached query hooks (and the sync sweep) wrote Dexie rows.
// The explicit-refresh path needs the freshly fetched pages to land in the
// local cache (bulkPut + search/row-cache invalidation), so this helper
// maps a page of domain items onto the right Dexie table using the shared
// row mappers. No-op when the cache subsystem is off or cold.

import type {
    Album,
    AlbumArtist,
    Artist,
    Genre,
    Playlist,
    Song,
} from '/@/shared/types/domain-types';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import { markRowsChangedFromPage, pageRefsFromItems } from './local-cache';
import {
    toCachedAlbumRow,
    toCachedArtistRow,
    toCachedGenreRow,
    toCachedPlaylistRow,
    toCachedSongRow,
} from './row-mappers';
import { markSearchDirty } from './search';

import { LibraryItem } from '/@/shared/types/domain-types';

type PageItems = ReadonlyArray<{ id?: string; updatedAt?: string }>;

export const applyListPageToCache = async (
    itemType: LibraryItem,
    items: unknown[],
): Promise<void> => {
    if (!items || items.length === 0) return;
    const db = isCacheAvailableSync() ? getActiveCacheDb() : undefined;
    if (!db) return;

    try {
        switch (itemType) {
            case LibraryItem.ALBUM:
                await db.albums.bulkPut((items as Album[]).map(toCachedAlbumRow));
                markSearchDirty('albums');
                markRowsChangedFromPage('albums', pageRefsFromItems(items as PageItems));
                break;
            case LibraryItem.ALBUM_ARTIST:
                await db.artists.bulkPut(
                    (items as AlbumArtist[]).map((a) => toCachedArtistRow(a, 'AlbumArtist')),
                );
                markSearchDirty('artists');
                markRowsChangedFromPage('albumArtists', pageRefsFromItems(items as PageItems));
                break;
            case LibraryItem.ARTIST:
                await db.artists.bulkPut(
                    (items as Artist[]).map((a) => toCachedArtistRow(a, 'Artist')),
                );
                markSearchDirty('artists');
                markRowsChangedFromPage('artists', pageRefsFromItems(items as PageItems));
                break;
            case LibraryItem.GENRE:
                await db.genres.bulkPut((items as Genre[]).map(toCachedGenreRow));
                break;
            case LibraryItem.PLAYLIST:
                await db.playlists.bulkPut((items as Playlist[]).map(toCachedPlaylistRow));
                markSearchDirty('playlists');
                break;
            case LibraryItem.SONG:
                await db.songs.bulkPut((items as Song[]).map(toCachedSongRow));
                markSearchDirty('songs');
                markRowsChangedFromPage('songs', pageRefsFromItems(items as PageItems));
                break;
            default:
                break;
        }
    } catch (err) {
        console.warn('[cache] applyListPageToCache failed', itemType, err);
    }
};
