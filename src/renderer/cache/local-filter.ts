// Pure-function filter / sort / paginate helpers that operate on rows
// pulled out of the Dexie cache. They are intentionally side-effect free
// so future tests can import them directly without a Dexie shim — the
// migrated hook code does the table lookup and hands raw rows down.
//
// Every helper returns the same envelope as the corresponding controller
// response so the wrapping `useCachedQuery` / `useCachedInfiniteQuery`
// callers can swap them in transparently:
//
//   { items, startIndex, totalRecordCount }
//
// Filters that can't be reproduced from the local indexes (server-only
// flags, custom backend filters, recently-played semantics that depend on
// up-to-the-second server state) cause the helper to return `undefined`
// so the caller falls back to the network.

import type {
    Album,
    AlbumArtist,
    AlbumArtistListQuery,
    AlbumArtistListResponse,
    AlbumListQuery,
    AlbumListResponse,
    ArtistListQuery,
    ArtistListResponse,
    Song,
    SongListQuery,
    SongListResponse,
} from '/@/shared/types/domain-types';

import type { CachedAlbum, CachedArtist, CachedSong } from './types';

import {
    AlbumArtistListSort,
    AlbumListSort,
    ArtistListSort,
    SongListSort,
    SortOrder,
} from '/@/shared/types/domain-types';

// ---------------------------------------------------------------------------
// Shared comparator helpers
// ---------------------------------------------------------------------------

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const cmpStr = (a: string | undefined, b: string | undefined): number =>
    collator.compare(a ?? '', b ?? '');

const cmpNum = (a: null | number | undefined, b: null | number | undefined): number => {
    const av = a ?? 0;
    const bv = b ?? 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
};

const cmpDate = (a: null | string | undefined, b: null | string | undefined): number => {
    const av = a ?? '';
    const bv = b ?? '';
    return av < bv ? -1 : av > bv ? 1 : 0;
};

// Fisher-Yates shuffle, used by RANDOM sort. The cached "random" is local
// to the client; the network revalidates with the server's own random pick
// independently, so users still see fresh permutations on a refetch.
const shuffleInPlace = <T>(arr: T[]): T[] => {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
};

const applyDirection = <T>(rows: T[], order: SortOrder | undefined): T[] => {
    if (order === SortOrder.DESC) rows.reverse();
    return rows;
};

const paginate = <T>(
    items: T[],
    startIndex: number | undefined,
    limit: number | undefined,
): T[] => {
    const start = Math.max(0, startIndex ?? 0);
    if (limit === undefined || limit < 0) return items.slice(start);
    return items.slice(start, start + limit);
};

const hasUnsupportedAlbumFilter = (query: AlbumListQuery | undefined): boolean => {
    if (!query) return false;
    if (query.compilation !== undefined) return true;
    if (query.hasRating !== undefined) return true;
    if (query.isRecentlyPlayed !== undefined) return true;
    if (query.musicFolderId) return true;
    if (query._custom && Object.keys(query._custom).length > 0) return true;
    return false;
};

const hasUnsupportedSongFilter = (query: SongListQuery): boolean => {
    if (query.hasRating !== undefined) return true;
    if (query.musicFolderId) return true;
    if (query.minYear !== undefined || query.maxYear !== undefined) return true;
    if (query._custom && Object.keys(query._custom).length > 0) return true;
    return false;
};

const hasUnsupportedAlbumArtistFilter = (query: AlbumArtistListQuery | undefined): boolean => {
    if (!query) return false;
    if (query.musicFolderId) return true;
    if (query._custom && Object.keys(query._custom).length > 0) return true;
    return false;
};

const hasUnsupportedArtistFilter = (query: ArtistListQuery | undefined): boolean => {
    if (!query) return false;
    if (query.musicFolderId) return true;
    if (query.role) return true;
    if (query._custom && Object.keys(query._custom).length > 0) return true;
    return false;
};

// ---------------------------------------------------------------------------
// Album filter / sort
// ---------------------------------------------------------------------------

const sortAlbums = (rows: CachedAlbum[], sortBy: AlbumListSort | undefined): CachedAlbum[] => {
    switch (sortBy) {
        case AlbumListSort.COMMUNITY_RATING:
        case AlbumListSort.CRITIC_RATING:
        case AlbumListSort.RATING:
            rows.sort((a, b) => cmpNum(a.Payload.userRating, b.Payload.userRating));
            break;
        case AlbumListSort.PLAY_COUNT:
            rows.sort((a, b) => cmpNum(a.Payload.playCount, b.Payload.playCount));
            break;
        case AlbumListSort.RANDOM:
            shuffleInPlace(rows);
            break;
        case AlbumListSort.RECENTLY_ADDED:
            rows.sort((a, b) => cmpDate(a.Payload.createdAt, b.Payload.createdAt));
            break;
        case AlbumListSort.RECENTLY_PLAYED:
            rows.sort((a, b) => cmpDate(a.Payload.lastPlayedAt, b.Payload.lastPlayedAt));
            break;
        case AlbumListSort.RELEASE_DATE:
        case AlbumListSort.YEAR:
            rows.sort((a, b) => cmpNum(a.ProductionYear, b.ProductionYear));
            break;
        case AlbumListSort.NAME:
        case AlbumListSort.SORT_NAME:
        default:
            rows.sort((a, b) => cmpStr(a.SortName, b.SortName));
            break;
    }
    return rows;
};

export interface FilterAlbumsArgs {
    favoriteAlbumIds?: Set<string>;
    query: AlbumListQuery;
    rows: CachedAlbum[];
}

/**
 * Apply genre / year / favorite / artist filters to a CachedAlbum row
 * set, then sort and paginate. The caller is responsible for any cheap
 * pre-filtering it can do via Dexie indexes (e.g. `.where('AlbumArtistId')`)
 * before handing the rows over.
 *
 * Returns `undefined` when the query contains filters the cache can't
 * answer authoritatively (musicFolderId, compilation, _custom, …) so the
 * caller can fall through to the network.
 */
export const filterAlbumsLocal = (args: FilterAlbumsArgs): AlbumListResponse | undefined => {
    const { favoriteAlbumIds, query, rows } = args;
    if (hasUnsupportedAlbumFilter(query)) return undefined;

    const start = performance.now();
    const fromCount = rows.length;

    let out = rows;

    if (query.favorite === true) {
        if (!favoriteAlbumIds) return undefined;
        out = out.filter((r) => favoriteAlbumIds.has(r.Id));
    } else if (query.favorite === false) {
        if (!favoriteAlbumIds) return undefined;
        out = out.filter((r) => !favoriteAlbumIds.has(r.Id));
    }

    if (query.artistIds && query.artistIds.length > 0) {
        const set = new Set(query.artistIds);
        out = out.filter((r) => {
            // Primary album-artist matches the indexed column. Fall back
            // to scanning the full albumArtists array for compilations
            // and multi-artist albums.
            if (set.has(r.AlbumArtistId)) return true;
            return r.Payload.albumArtists?.some((a) => set.has(a.id));
        });
    }

    if (query.genreIds && query.genreIds.length > 0) {
        const set = new Set(query.genreIds);
        out = out.filter((r) => r.Payload.genres?.some((g) => set.has(g.id)));
    }

    if (query.minYear !== undefined) {
        out = out.filter((r) => (r.ProductionYear ?? 0) >= query.minYear!);
    }
    if (query.maxYear !== undefined) {
        out = out.filter((r) => (r.ProductionYear ?? 0) <= query.maxYear!);
    }

    if (query.searchTerm) {
        const needle = query.searchTerm.toLowerCase();
        out = out.filter(
            (r) =>
                (r.Payload.name ?? '').toLowerCase().includes(needle) ||
                (r.Payload.albumArtistName ?? '').toLowerCase().includes(needle),
        );
    }

    out = sortAlbums(out.slice(), query.sortBy);
    out = applyDirection(out, query.sortOrder);

    const totalRecordCount = out.length;
    const startIndex = query.startIndex ?? 0;
    const items = paginate(out, startIndex, query.limit).map<Album>((r) => r.Payload);

    console.info('[cache] filter: albums', {
        fromCount,
        hits: totalRecordCount,
        ms: Math.round(performance.now() - start),
        page: items.length,
    });

    return { items, startIndex, totalRecordCount };
};

// ---------------------------------------------------------------------------
// Artist filter / sort (covers both AlbumArtist and Artist list shapes)
// ---------------------------------------------------------------------------

type AnyArtistSort = AlbumArtistListSort | ArtistListSort;

const sortArtists = (rows: CachedArtist[], sortBy: AnyArtistSort | undefined): CachedArtist[] => {
    switch (sortBy) {
        case AlbumArtistListSort.ALBUM_COUNT:
            rows.sort((a, b) => cmpNum(a.Payload.albumCount, b.Payload.albumCount));
            break;
        case AlbumArtistListSort.DURATION:
            rows.sort((a, b) => cmpNum(a.Payload.duration, b.Payload.duration));
            break;
        case AlbumArtistListSort.PLAY_COUNT:
            rows.sort((a, b) => cmpNum(a.Payload.playCount, b.Payload.playCount));
            break;
        case AlbumArtistListSort.RANDOM:
            shuffleInPlace(rows);
            break;
        case AlbumArtistListSort.RATING:
            rows.sort((a, b) => cmpNum(a.Payload.userRating, b.Payload.userRating));
            break;
        case AlbumArtistListSort.RECENTLY_ADDED:
            rows.sort((a, b) => cmpDate(a.Payload.createdAt, b.Payload.createdAt));
            break;
        case AlbumArtistListSort.SONG_COUNT:
            rows.sort((a, b) => cmpNum(a.Payload.songCount, b.Payload.songCount));
            break;
        case AlbumArtistListSort.NAME:
        default:
            rows.sort((a, b) => cmpStr(a.SortName, b.SortName));
            break;
    }
    return rows;
};

const applyArtistFilters = (
    rows: CachedArtist[],
    query: { favorite?: boolean; searchTerm?: string },
    favoriteArtistIds: Set<string> | undefined,
): CachedArtist[] | undefined => {
    let out = rows;
    if (query.favorite === true) {
        if (!favoriteArtistIds) return undefined;
        out = out.filter((r) => favoriteArtistIds.has(r.Id));
    } else if (query.favorite === false) {
        if (!favoriteArtistIds) return undefined;
        out = out.filter((r) => !favoriteArtistIds.has(r.Id));
    }
    if (query.searchTerm) {
        const needle = query.searchTerm.toLowerCase();
        out = out.filter((r) => (r.Payload.name ?? '').toLowerCase().includes(needle));
    }
    return out;
};

export interface FilterArtistsArgs {
    favoriteArtistIds?: Set<string>;
    genreIds?: string[];
    query: AlbumArtistListQuery;
    rows: CachedArtist[];
}

/**
 * AlbumArtist list filter+sort+paginate. The caller filters by Kind via
 * Dexie before calling this so we don't drag Artist rows through. Genre
 * filtering is in-memory because the Dexie row doesn't index the genres
 * array; if the library is large and a genre is rare, the caller may
 * choose to skip the local path entirely.
 */
export const filterAlbumArtistsLocal = (
    args: FilterArtistsArgs,
): AlbumArtistListResponse | undefined => {
    const { favoriteArtistIds, genreIds, query, rows } = args;
    if (hasUnsupportedAlbumArtistFilter(query)) return undefined;

    const start = performance.now();
    const fromCount = rows.length;

    let out = applyArtistFilters(rows, query, favoriteArtistIds);
    if (out === undefined) return undefined;

    if (genreIds && genreIds.length > 0) {
        const set = new Set(genreIds);
        out = out.filter((r) => r.Payload.genres?.some((g) => set.has(g.id)));
    }

    out = sortArtists(out.slice(), query.sortBy);
    out = applyDirection(out, query.sortOrder);

    const totalRecordCount = out.length;
    const startIndex = query.startIndex ?? 0;
    const items = paginate(out, startIndex, query.limit).map<AlbumArtist>((r) => r.Payload);

    console.info('[cache] filter: albumArtists', {
        fromCount,
        hits: totalRecordCount,
        ms: Math.round(performance.now() - start),
        page: items.length,
    });

    return { items, startIndex, totalRecordCount };
};

export interface FilterSongArtistsArgs {
    favoriteArtistIds?: Set<string>;
    genreIds?: string[];
    query: ArtistListQuery;
    rows: CachedArtist[];
}

/**
 * Same as `filterAlbumArtistsLocal` but typed for the song-artist (Kind ===
 * 'Artist') list. Filters that are server-owned (`role`) cause an early
 * `undefined` return.
 */
export const filterArtistsLocal = (args: FilterSongArtistsArgs): ArtistListResponse | undefined => {
    const { favoriteArtistIds, genreIds, query, rows } = args;
    if (hasUnsupportedArtistFilter(query)) return undefined;

    const start = performance.now();
    const fromCount = rows.length;

    let out = applyArtistFilters(rows, query, favoriteArtistIds);
    if (out === undefined) return undefined;

    if (genreIds && genreIds.length > 0) {
        const set = new Set(genreIds);
        out = out.filter((r) => r.Payload.genres?.some((g) => set.has(g.id)));
    }

    out = sortArtists(out.slice(), query.sortBy);
    out = applyDirection(out, query.sortOrder);

    const totalRecordCount = out.length;
    const startIndex = query.startIndex ?? 0;
    const items = paginate(out, startIndex, query.limit).map<AlbumArtist>((r) => r.Payload);

    console.info('[cache] filter: artists', {
        fromCount,
        hits: totalRecordCount,
        ms: Math.round(performance.now() - start),
        page: items.length,
    });

    return { items, startIndex, totalRecordCount };
};

// ---------------------------------------------------------------------------
// Song filter / sort
// ---------------------------------------------------------------------------

const sortSongs = (rows: CachedSong[], sortBy: SongListSort | undefined): CachedSong[] => {
    switch (sortBy) {
        case SongListSort.ALBUM:
        case SongListSort.RELEASE_DATE:
            rows.sort((a, b) => {
                const c = cmpStr(a.Payload.album ?? '', b.Payload.album ?? '');
                if (c !== 0) return c;
                const disc = cmpNum(a.ParentIndexNumber, b.ParentIndexNumber);
                if (disc !== 0) return disc;
                return cmpNum(a.IndexNumber, b.IndexNumber);
            });
            break;
        case SongListSort.ALBUM_ARTIST:
        case SongListSort.ARTIST:
            rows.sort((a, b) =>
                cmpStr(a.Payload.albumArtistName ?? '', b.Payload.albumArtistName ?? ''),
            );
            break;
        case SongListSort.DURATION:
            rows.sort((a, b) => cmpNum(a.Payload.duration, b.Payload.duration));
            break;
        case SongListSort.PLAY_COUNT:
            rows.sort((a, b) => cmpNum(a.Payload.playCount, b.Payload.playCount));
            break;
        case SongListSort.RANDOM:
            shuffleInPlace(rows);
            break;
        case SongListSort.RATING:
            rows.sort((a, b) => cmpNum(a.Payload.userRating, b.Payload.userRating));
            break;
        case SongListSort.RECENTLY_ADDED:
            rows.sort((a, b) => cmpDate(a.Payload.createdAt, b.Payload.createdAt));
            break;
        case SongListSort.RECENTLY_PLAYED:
            rows.sort((a, b) => cmpDate(a.Payload.lastPlayedAt, b.Payload.lastPlayedAt));
            break;
        case SongListSort.YEAR:
            rows.sort((a, b) => cmpNum(a.Payload.releaseYear, b.Payload.releaseYear));
            break;
        case SongListSort.NAME:
        case SongListSort.SORT_NAME:
        default:
            rows.sort((a, b) => cmpStr(a.Payload.name, b.Payload.name));
            break;
    }
    return rows;
};

export interface FilterSongsArgs {
    favoriteSongIds?: Set<string>;
    query: SongListQuery;
    rows: CachedSong[];
}

/**
 * Apply album / artist / genre / favorite filters to a CachedSong row
 * set, then sort and paginate. Server-only filters (year ranges, custom
 * filters, musicFolderId) cause an `undefined` return so the caller falls
 * back to the network.
 */
export const filterSongsLocal = (args: FilterSongsArgs): SongListResponse | undefined => {
    const { favoriteSongIds, query, rows } = args;
    if (hasUnsupportedSongFilter(query)) return undefined;

    const start = performance.now();
    const fromCount = rows.length;

    let out = rows;

    if (query.favorite === true) {
        if (!favoriteSongIds) return undefined;
        out = out.filter((r) => favoriteSongIds.has(r.Id));
    } else if (query.favorite === false) {
        if (!favoriteSongIds) return undefined;
        out = out.filter((r) => !favoriteSongIds.has(r.Id));
    }

    if (query.albumIds && query.albumIds.length > 0) {
        const set = new Set(query.albumIds);
        out = out.filter((r) => r.AlbumId !== undefined && set.has(r.AlbumId));
    }

    if (query.albumArtistIds && query.albumArtistIds.length > 0) {
        const set = new Set(query.albumArtistIds);
        out = out.filter(
            (r) =>
                (r.AlbumArtistId !== undefined && set.has(r.AlbumArtistId)) ||
                r.Payload.albumArtists?.some((a) => set.has(a.id)),
        );
    }

    if (query.artistIds && query.artistIds.length > 0) {
        const set = new Set(query.artistIds);
        out = out.filter((r) => r.Payload.artists?.some((a) => set.has(a.id)));
    }

    if (query.genreIds && query.genreIds.length > 0) {
        const set = new Set(query.genreIds);
        out = out.filter((r) => r.Payload.genres?.some((g) => set.has(g.id)));
    }

    if (query.searchTerm) {
        const needle = query.searchTerm.toLowerCase();
        out = out.filter(
            (r) =>
                (r.Payload.name ?? '').toLowerCase().includes(needle) ||
                (r.Payload.albumArtistName ?? '').toLowerCase().includes(needle) ||
                (r.Payload.album ?? '').toLowerCase().includes(needle),
        );
    }

    out = sortSongs(out.slice(), query.sortBy);
    out = applyDirection(out, query.sortOrder);

    const totalRecordCount = out.length;
    const startIndex = query.startIndex ?? 0;
    const items = paginate(out, startIndex, query.limit).map<Song>((r) => r.Payload);

    console.info('[cache] filter: songs', {
        fromCount,
        hits: totalRecordCount,
        ms: Math.round(performance.now() - start),
        page: items.length,
    });

    return { items, startIndex, totalRecordCount };
};
