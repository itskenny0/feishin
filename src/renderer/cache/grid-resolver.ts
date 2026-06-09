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

import type { Album, AlbumArtist, Song } from '/@/shared/types/domain-types';

import type { CachedAlbum, CachedFavoriteKind } from './types';

import { isCacheAvailableSync } from './capability';
import { getActiveCacheDb } from './db';
import {
    loadAlbumArtistsRows,
    loadAlbumsRows,
    loadArtistsRows,
    loadSongsRows,
    lookupSorted,
    storeSorted,
} from './local-cache';
import {
    filterAlbumArtistsLocal,
    filterAlbumsLocal,
    filterArtistsLocal,
    filterGenresLocal,
    filterPlaylistsLocal,
    filterSongsLocal,
} from './local-filter';

import {
    AlbumArtistListQuery,
    AlbumArtistListSort,
    AlbumListQuery,
    AlbumListSort,
    ArtistListQuery,
    GenreListQuery,
    PlaylistListQuery,
    SongListQuery,
    SongListSort,
} from '/@/shared/types/domain-types';

interface BaseArgs<TQuery> {
    limit: number;
    query: TQuery;
    startIndex: number;
}

const getDb = () => (isCacheAvailableSync() ? getActiveCacheDb() : undefined);

// Sample-rate logging so a busy infinite scroll doesn't spam devtools.
let hitCounter = 0;
const logHit = (label: string, count: number, memo?: 'cold' | 'memo'): void => {
    hitCounter += 1;
    if (hitCounter % 50 === 1) {
        console.info(`[cache] grid: hit ${label} (${count} items)`, memo ? { memo } : undefined);
    }
};

// Build the LRU signature for a list query. The startIndex + limit fields
// are excluded so every page of the same scroll lands on the same memo
// entry — pagination becomes a slice on the cached sorted list.
const memoSignature = (label: string, query: Record<string, unknown>): string => {
    const stripped: Record<string, unknown> = {};
    for (const k of Object.keys(query)) {
        if (k === 'startIndex' || k === 'limit') continue;
        const v = query[k];
        if (v === undefined) continue;
        stripped[k] = v;
    }
    return `${label}:${JSON.stringify(stripped)}`;
};

// Apply the (startIndex, limit) slice to a memo-cached sorted result and
// rebuild the AlbumListResponse-style envelope. Used after a memo hit so
// pagination is O(limit) rather than re-sorting the whole table.
const paginateMemo = <T>(
    items: T[],
    startIndex: number,
    limit: number,
): { items: T[]; startIndex: number; totalRecordCount: number } => ({
    items: items.slice(startIndex, startIndex + limit),
    startIndex,
    totalRecordCount: items.length,
});

// ---------------------------------------------------------------------------
// Albums
// ---------------------------------------------------------------------------

const readFavoriteIds = async (
    db: NonNullable<ReturnType<typeof getActiveCacheDb>>,
    itemType: CachedFavoriteKind,
): Promise<Set<string>> => {
    // `where('ItemType')` rides the v8 standalone index — Dexie can
    // scan only matching rows via the IDB cursor instead of pulling
    // the entire favorites table into JS for a `.filter()` walk.
    const rows = await db.favorites.where('ItemType').equals(itemType).toArray();
    return new Set(rows.filter((r) => r.IsFavorite).map((r) => r.ItemId));
};

export const resolveAlbumPage = async (
    args: BaseArgs<AlbumListQuery>,
): Promise<undefined | { items: unknown[]; startIndex: number; totalRecordCount: number }> => {
    const db = getDb();
    if (!db) return undefined;

    const { limit, query, startIndex } = args;

    // Try the sorted-result memo first. The signature includes every
    // filter field except pagination, so page 1 / page 2 / page 3 of the
    // same scroll all hit the same entry.
    const sig = memoSignature('albums', query as unknown as Record<string, unknown>);
    const cached = lookupSorted<Album>('albums', sig);
    if (cached) {
        const page = paginateMemo(cached, startIndex, limit);
        logHit('albums', page.items.length, 'memo');
        return page;
    }

    // Memo miss — pull the rows (memoized in-JS by `local-cache`) and run
    // the filter/sort. The single-artist case hits the Dexie index
    // directly; the unfiltered case shares the JS-heap row cache so the
    // 50k-row materialisation only happens once per dirty-mark.
    let rows: CachedAlbum[];
    if (query.artistIds && query.artistIds.length === 1) {
        rows = await db.albums.where('AlbumArtistId').equals(query.artistIds[0]).toArray();
    } else {
        rows = await loadAlbumsRows(db);
    }
    if (rows.length === 0) return undefined;

    const needsFavorites = query.favorite !== undefined || query.sortBy === AlbumListSort.FAVORITED;
    const favoriteAlbumIds = needsFavorites ? await readFavoriteIds(db, 'Album') : undefined;

    // Filter+sort over the full row set ONCE (limit undefined skips
    // pagination so we get the complete sorted list), then store the
    // result and slice for this page. Subsequent pages reuse the cached
    // sorted list via the lookupSorted() path above.
    const fullQuery: AlbumListQuery = {
        ...query,
        limit: undefined,
        startIndex: 0,
    };
    const out = filterAlbumsLocal({
        favoriteAlbumIds,
        query: fullQuery,
        rows,
    });
    if (out === undefined) return undefined;
    storeSorted<Album>('albums', sig, out.items);
    const page = paginateMemo(out.items, startIndex, limit);
    logHit('albums', page.items.length, 'cold');
    return page;
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

    const sig = memoSignature('albumArtists', query as unknown as Record<string, unknown>);
    const cached = lookupSorted<AlbumArtist>('albumArtists', sig);
    if (cached) {
        const page = paginateMemo(cached, startIndex, limit);
        logHit('albumArtists', page.items.length, 'memo');
        return { items: page.items };
    }

    const rows = await loadAlbumArtistsRows(db);
    if (rows.length === 0) return undefined;

    const needsFavorites =
        query.favorite !== undefined || query.sortBy === AlbumArtistListSort.FAVORITED;
    const favoriteArtistIds = needsFavorites ? await readFavoriteIds(db, 'AlbumArtist') : undefined;

    const out = filterAlbumArtistsLocal({
        favoriteArtistIds,
        query: { ...query, limit: undefined, startIndex: 0 },
        rows,
    });
    if (out === undefined) return undefined;
    storeSorted<AlbumArtist>('albumArtists', sig, out.items);
    const page = paginateMemo(out.items, startIndex, limit);
    logHit('albumArtists', page.items.length, 'cold');
    return { items: page.items };
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

    const sig = memoSignature('artists', query as unknown as Record<string, unknown>);
    const cached = lookupSorted<AlbumArtist>('artists', sig);
    if (cached) {
        const page = paginateMemo(cached, startIndex, limit);
        logHit('artists', page.items.length, 'memo');
        return { items: page.items };
    }

    const rows = await loadArtistsRows(db);
    if (rows.length === 0) return undefined;

    // Jellyfin doesn't distinguish song-artist favorites from album-artist
    // favorites — the same underlying record is toggled. Our favorites sweep
    // stores them as 'AlbumArtist', so we read from that bucket here too.
    const favoriteArtistIds =
        query.favorite !== undefined ? await readFavoriteIds(db, 'AlbumArtist') : undefined;

    const out = filterArtistsLocal({
        favoriteArtistIds,
        query: { ...query, limit: undefined, startIndex: 0 },
        rows,
    });
    if (out === undefined) return undefined;
    storeSorted<AlbumArtist>('artists', sig, out.items);
    const page = paginateMemo(out.items, startIndex, limit);
    logHit('artists', page.items.length, 'cold');
    return { items: page.items };
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

    const sig = memoSignature('songs', query as unknown as Record<string, unknown>);
    const cached = lookupSorted<Song>('songs', sig);
    if (cached) {
        const page = paginateMemo(cached, startIndex, limit);
        logHit('songs', page.items.length, 'memo');
        return { items: page.items };
    }

    // Prefer indexed pre-filters before scanning the full songs table.
    // The full-table path goes through the JS-heap row cache so a 50k-row
    // structured-clone only runs once per dirty-mark.
    let rows;
    if (query.albumIds?.length === 1) {
        rows = await db.songs.where('AlbumId').equals(query.albumIds[0]).toArray();
    } else if (query.albumArtistIds?.length === 1) {
        rows = await db.songs.where('AlbumArtistId').equals(query.albumArtistIds[0]).toArray();
    } else {
        rows = await loadSongsRows(db);
    }
    if (rows.length === 0) return undefined;

    const needsSongFavorites =
        query.favorite !== undefined || query.sortBy === SongListSort.FAVORITED;
    const favoriteSongIds = needsSongFavorites ? await readFavoriteIds(db, 'Song') : undefined;

    const out = filterSongsLocal({
        favoriteSongIds,
        query: { ...query, limit: undefined, startIndex: 0 },
        rows,
    });
    if (out === undefined) return undefined;
    storeSorted<Song>('songs', sig, out.items);
    const page = paginateMemo(out.items, startIndex, limit);
    logHit('songs', page.items.length, 'cold');
    return { items: page.items };
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

    const out = filterGenresLocal({ query: { ...query, limit, startIndex }, rows });
    if (out === undefined) return undefined;
    logHit('genres', out.items.length);
    return { items: out.items };
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

    const out = filterPlaylistsLocal({ query: { ...query, limit, startIndex }, rows });
    if (out === undefined) return undefined;
    logHit('playlists', out.items.length);
    return { items: out.items };
};
