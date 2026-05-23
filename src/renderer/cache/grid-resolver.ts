// Cache-first page resolvers for the infinite-loader-driven grid/table
// surfaces (album / artist / album-artist / song / genre / playlist). Each
// resolver mirrors the (query, startIndex, limit) contract of the existing
// controller calls and returns the same `{ items, ... }` envelope, so the
// loader can drop the cached page into the dataMap before the network call
// completes.
//
// All resolvers return `undefined` when:
//   - the cache module is disabled or not yet initialised
//   - the active DB has no rows for the entity (cold start)
//   - the query carries a filter the cache can't answer (musicFolderId,
//     compilation flag, _custom, ...)
// The loader treats `undefined` as "no cache hit; go to network".

import type { CachedAlbum } from './types';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import {
    filterAlbumArtistsLocal,
    filterAlbumsLocal,
    filterArtistsLocal,
    filterSongsLocal,
} from './local-filter';

import {
    AlbumArtistListQuery,
    AlbumListQuery,
    ArtistListQuery,
    Genre,
    GenreListQuery,
    Playlist,
    PlaylistListQuery,
    PlaylistListSort,
    SongListQuery,
} from '/@/shared/types/domain-types';

interface BaseArgs<TQuery> {
    limit: number;
    query: TQuery;
    startIndex: number;
}

const getDb = () => (isCacheAvailableSync() ? getActiveCacheDb() : undefined);

// Sample-rate logging so a busy infinite scroll doesn't spam devtools.
let hitCounter = 0;
const logHit = (label: string, count: number): void => {
    hitCounter += 1;
    if (hitCounter % 50 === 1) {
        console.info(`[cache] grid: hit ${label} (${count} items)`);
    }
};

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

const readFavoriteIds = async (
    db: NonNullable<ReturnType<typeof getActiveCacheDb>>,
    itemType: 'Album' | 'Artist' | 'Song',
): Promise<Set<string>> => {
    const rows = await db.favorites.filter((r) => r.ItemType === itemType).toArray();
    return new Set(rows.filter((r) => r.IsFavorite).map((r) => r.ItemId));
};

export const resolveAlbumPage = async (
    args: BaseArgs<AlbumListQuery>,
): Promise<undefined | { items: unknown[] }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;

    let rows: CachedAlbum[];
    if (query.artistIds && query.artistIds.length === 1) {
        rows = await db.albums.where('AlbumArtistId').equals(query.artistIds[0]).toArray();
    } else {
        rows = await db.albums.toArray();
    }
    if (rows.length === 0) return undefined;

    const favoriteAlbumIds =
        query.favorite !== undefined ? await readFavoriteIds(db, 'Album') : undefined;

    const out = filterAlbumsLocal({
        favoriteAlbumIds,
        query: { ...query, limit, startIndex },
        rows,
    });
    if (out === undefined) return undefined;
    logHit('albums', out.items.length);
    return { items: out.items };
};

// ---------------------------------------------------------------------------
// Album-artists
// ---------------------------------------------------------------------------

export const resolveAlbumArtistPage = async (
    args: BaseArgs<AlbumArtistListQuery>,
): Promise<undefined | { items: unknown[] }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;
    const rows = await db.artists.where('Kind').equals('AlbumArtist').toArray();
    if (rows.length === 0) return undefined;

    const favoriteArtistIds =
        query.favorite !== undefined ? await readFavoriteIds(db, 'Artist') : undefined;

    const out = filterAlbumArtistsLocal({
        favoriteArtistIds,
        query: { ...query, limit, startIndex },
        rows,
    });
    if (out === undefined) return undefined;
    logHit('albumArtists', out.items.length);
    return { items: out.items };
};

// ---------------------------------------------------------------------------
// Song-artists ("Artist" kind)
// ---------------------------------------------------------------------------

export const resolveArtistPage = async (
    args: BaseArgs<ArtistListQuery>,
): Promise<undefined | { items: unknown[] }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;
    const rows = await db.artists.where('Kind').equals('Artist').toArray();
    if (rows.length === 0) return undefined;

    const favoriteArtistIds =
        query.favorite !== undefined ? await readFavoriteIds(db, 'Artist') : undefined;

    const out = filterArtistsLocal({
        favoriteArtistIds,
        query: { ...query, limit, startIndex },
        rows,
    });
    if (out === undefined) return undefined;
    logHit('artists', out.items.length);
    return { items: out.items };
};

// ---------------------------------------------------------------------------
// Songs
// ---------------------------------------------------------------------------

export const resolveSongPage = async (
    args: BaseArgs<SongListQuery>,
): Promise<undefined | { items: unknown[] }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;

    // Prefer indexed pre-filters before scanning the full songs table.
    let rows;
    if (query.albumIds?.length === 1) {
        rows = await db.songs.where('AlbumId').equals(query.albumIds[0]).toArray();
    } else if (query.albumArtistIds?.length === 1) {
        rows = await db.songs.where('AlbumArtistId').equals(query.albumArtistIds[0]).toArray();
    } else {
        rows = await db.songs.toArray();
    }
    if (rows.length === 0) return undefined;

    let favoriteSongIds: Set<string> | undefined;
    if (query.favorite !== undefined) {
        favoriteSongIds = await readFavoriteIds(db, 'Song');
    }

    const out = filterSongsLocal({
        favoriteSongIds,
        query: { ...query, limit, startIndex },
        rows,
    });
    if (out === undefined) return undefined;
    logHit('songs', out.items.length);
    return { items: out.items };
};

// ---------------------------------------------------------------------------
// Genres (no rich filter; just sort + paginate)
// ---------------------------------------------------------------------------

export const resolveGenrePage = async (
    args: BaseArgs<GenreListQuery>,
): Promise<undefined | { items: unknown[] }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;
    const rows = await db.genres.toArray();
    if (rows.length === 0) return undefined;

    const sorted = rows.slice().sort((a, b) => (a.SortName ?? '').localeCompare(b.SortName ?? ''));
    if (query.sortOrder === 'DESC') sorted.reverse();

    const items: Genre[] = sorted
        .slice(startIndex, startIndex + limit)
        .map((r) => r.Payload as Genre);
    logHit('genres', items.length);
    return { items };
};

// ---------------------------------------------------------------------------
// Playlists (no rich filter; just sort + paginate)
// ---------------------------------------------------------------------------

export const resolvePlaylistPage = async (
    args: BaseArgs<PlaylistListQuery>,
): Promise<undefined | { items: unknown[] }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;
    const rows = await db.playlists.toArray();
    if (rows.length === 0) return undefined;

    let sorted = rows.slice();
    if (query.searchTerm) {
        const needle = query.searchTerm.toLowerCase();
        sorted = sorted.filter((r) => (r.Payload?.name ?? '').toLowerCase().includes(needle));
    }

    // Honour every PlaylistListSort variant the type defines. Falling back
    // to NAME when an unknown sort is requested keeps the cache responsive
    // for newer sort enums and unknown shapes from the wire.
    switch (query.sortBy) {
        case PlaylistListSort.DURATION:
            sorted.sort((a, b) => (a.Payload?.duration ?? 0) - (b.Payload?.duration ?? 0));
            break;
        case PlaylistListSort.OWNER:
            sorted.sort((a, b) => (a.Payload?.owner ?? '').localeCompare(b.Payload?.owner ?? ''));
            break;
        case PlaylistListSort.PUBLIC:
            sorted.sort(
                (a, b) => Number(b.Payload?.public ?? false) - Number(a.Payload?.public ?? false),
            );
            break;
        case PlaylistListSort.SONG_COUNT:
            sorted.sort((a, b) => (a.Payload?.songCount ?? 0) - (b.Payload?.songCount ?? 0));
            break;
        case PlaylistListSort.UPDATED_AT:
            // DateLastSaved is the cached `updatedAt`; empty strings sort
            // to the front of ASC / back of DESC, which is the same
            // behaviour the server gives for rows missing the field.
            sorted.sort((a, b) => (a.DateLastSaved ?? '').localeCompare(b.DateLastSaved ?? ''));
            break;
        case PlaylistListSort.NAME:
        default:
            sorted.sort((a, b) => (a.SortName ?? '').localeCompare(b.SortName ?? ''));
            break;
    }
    if (query.sortOrder === 'DESC') sorted.reverse();

    const items: Playlist[] = sorted
        .slice(startIndex, startIndex + limit)
        .map((r) => r.Payload as Playlist);
    logHit('playlists', items.length);
    return { items };
};
