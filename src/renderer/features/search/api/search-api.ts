import type { InfiniteData } from '@tanstack/react-query';

import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';

import { api } from '/@/renderer/api';
import { queryKeys } from '/@/renderer/api/query-keys';
import {
    readSnapshot,
    searchAlbumsLocal,
    searchArtistsLocal,
    searchSongsLocal,
    writeSnapshot,
} from '/@/renderer/cache';
import { QueryHookArgs } from '/@/renderer/lib/react-query';
import {
    Album,
    AlbumArtist,
    SearchQuery,
    SearchResponse,
    Song,
} from '/@/shared/types/domain-types';

const SEARCH_PAGE_SIZE = 4;

// One-in-ten sampling so a debounced search bar that fires four queryFns
// per keystroke (three entity sections + the synchronous local hits per
// section) doesn't flood devtools. Counter is module-scoped so every
// section shares the same sampling window.
let searchUiLogCounter = 0;
const logSearchUiHitSampled = (
    entity: 'albumArtists' | 'albums' | 'songs',
    info: { localCount: number; ms: number; q: string },
): void => {
    searchUiLogCounter += 1;
    if (searchUiLogCounter % 10 === 1) {
        console.info(`[cache] search-ui: local hit (${entity})`, info);
    }
};

// Build a SearchResponse shape from a single-entity local hit list so we
// can write it into the snapshot map under the same key the network call
// will eventually produce. Only the first page (startIndex 0) is seeded;
// fuse.js doesn't model paging in any meaningful way and the user would
// be served by the network result by the time they click "view more".
const buildLocalAlbumArtistsResponse = (items: AlbumArtist[]): SearchResponse => ({
    albumArtists: items.slice(0, SEARCH_PAGE_SIZE),
    albums: [],
    songs: [],
});

const buildLocalAlbumsResponse = (items: Album[]): SearchResponse => ({
    albumArtists: [],
    albums: items.slice(0, SEARCH_PAGE_SIZE),
    songs: [],
});

const buildLocalSongsResponse = (items: Song[]): SearchResponse => ({
    albumArtists: [],
    albums: [],
    songs: items.slice(0, SEARCH_PAGE_SIZE),
});

const seedSnapshotWithLocalPage = (
    queryKey: ReturnType<typeof queryKeys.search.infiniteList>,
    page: SearchResponse,
): void => {
    // Only seed when there's no existing snapshot, or the existing
    // snapshot is single-page (i.e. the previous network result hasn't
    // overwritten it). Re-seeding on every keystroke would clobber a
    // multi-page network result the user has already paged through.
    const existing = readSnapshot<InfiniteData<SearchResponse, number>>(queryKey);
    if (existing && existing.pages.length > 0) return;
    const snapshot: InfiniteData<SearchResponse, number> = {
        pageParams: [0],
        pages: [page],
    };
    writeSnapshot(queryKey, snapshot);
};

export const searchQueries = {
    search: (args: QueryHookArgs<SearchQuery>) => {
        return queryOptions({
            queryFn: ({ signal }) => {
                return api.controller.search({
                    apiClientProps: { serverId: args.serverId, signal },
                    query: args.query,
                });
            },
            queryKey: queryKeys.search.list(args.serverId, args.query),
            ...args.options,
        });
    },
    searchAlbumArtistsInfinite: (args: {
        enabled?: boolean;
        searchTerm: string;
        serverId: string | undefined;
    }) => {
        const { enabled = true, searchTerm, serverId } = args;
        const queryKey = queryKeys.search.infiniteList(serverId ?? '', 'albumArtists', searchTerm);
        return infiniteQueryOptions({
            enabled: Boolean(serverId && searchTerm && enabled),
            getNextPageParam: (lastPage: SearchResponse, allPages: SearchResponse[]) => {
                const len = lastPage.albumArtists.length;
                if (len < SEARCH_PAGE_SIZE) return undefined;
                return allPages.length * SEARCH_PAGE_SIZE;
            },
            initialPageParam: 0,
            // Synchronous render of any snapshot we have for this exact
            // search-term key. The snapshot map is populated by both the
            // local fuse hits below AND any previously-completed network
            // result. The placeholder stays in place until the network
            // promise resolves, at which point react-query swaps in the
            // authoritative fresh page set.
            placeholderData: () => readSnapshot<InfiniteData<SearchResponse, number>>(queryKey),
            queryFn: async ({ pageParam, signal }) => {
                if (!serverId) throw new Error('serverId required');
                const startIndex = (pageParam ?? 0) as number;

                // Local-first: on the first page only, run the fuse index
                // against the trimmed search term and seed the snapshot
                // map so the NEXT mount of this same query string renders
                // synchronously via `placeholderData`. The lookup is fired
                // in parallel with the network call so the network round
                // trip isn't delayed by fuse's ~50 ms build.
                const localPromise =
                    startIndex === 0 && searchTerm.trim()
                        ? (async () => {
                              const t0 = performance.now();
                              try {
                                  const localArtists = await searchArtistsLocal(
                                      searchTerm,
                                      SEARCH_PAGE_SIZE,
                                  );
                                  if (localArtists.length > 0) {
                                      seedSnapshotWithLocalPage(
                                          queryKey,
                                          buildLocalAlbumArtistsResponse(localArtists),
                                      );
                                  }
                                  logSearchUiHitSampled('albumArtists', {
                                      localCount: localArtists.length,
                                      ms: Math.round(performance.now() - t0),
                                      q: searchTerm,
                                  });
                              } catch (err) {
                                  console.warn(
                                      '[cache] search-ui: local lookup failed (albumArtists)',
                                      err,
                                  );
                              }
                          })()
                        : undefined;

                const fresh = await api.controller.search({
                    apiClientProps: { serverId, signal },
                    query: {
                        albumArtistLimit: SEARCH_PAGE_SIZE,
                        albumArtistStartIndex: startIndex,
                        albumLimit: 0,
                        albumStartIndex: 0,
                        query: searchTerm,
                        songLimit: 0,
                        songStartIndex: 0,
                    },
                });

                // Make sure the local seed has landed before we overwrite
                // the snapshot with the fresh page — otherwise a slow
                // fuse build could clobber the just-written fresh result.
                if (localPromise) await localPromise;

                // Persist the authoritative network page so a remount on
                // the same query string skips straight past the fuse hits
                // into the real result set.
                const existing = readSnapshot<InfiniteData<SearchResponse, number>>(queryKey);
                const pages = existing?.pages ? [...existing.pages] : [];
                const pageParams = existing?.pageParams ? [...existing.pageParams] : [];
                const idx = pageParams.findIndex((p) => p === startIndex);
                if (idx >= 0) {
                    pages[idx] = fresh;
                } else {
                    // Replace any stale single-page fuse seed when the
                    // first network page lands. Anything after page 0 just
                    // appends.
                    if (startIndex === 0 && pages.length === 1 && pageParams[0] === 0) {
                        pages[0] = fresh;
                    } else {
                        pages.push(fresh);
                        pageParams.push(startIndex);
                    }
                }
                writeSnapshot(queryKey, { pageParams, pages });

                return fresh;
            },
            queryKey,
        });
    },
    searchAlbumsInfinite: (args: {
        enabled?: boolean;
        searchTerm: string;
        serverId: string | undefined;
    }) => {
        const { enabled = true, searchTerm, serverId } = args;
        const queryKey = queryKeys.search.infiniteList(serverId ?? '', 'albums', searchTerm);
        return infiniteQueryOptions({
            enabled: Boolean(serverId && searchTerm && enabled),
            getNextPageParam: (lastPage: SearchResponse, allPages: SearchResponse[]) => {
                const len = lastPage.albums.length;
                if (len < SEARCH_PAGE_SIZE) return undefined;
                return allPages.length * SEARCH_PAGE_SIZE;
            },
            initialPageParam: 0,
            placeholderData: () => readSnapshot<InfiniteData<SearchResponse, number>>(queryKey),
            queryFn: async ({ pageParam, signal }) => {
                if (!serverId) throw new Error('serverId required');
                const startIndex = (pageParam ?? 0) as number;

                const localPromise =
                    startIndex === 0 && searchTerm.trim()
                        ? (async () => {
                              const t0 = performance.now();
                              try {
                                  const localAlbums = await searchAlbumsLocal(
                                      searchTerm,
                                      SEARCH_PAGE_SIZE,
                                  );
                                  if (localAlbums.length > 0) {
                                      seedSnapshotWithLocalPage(
                                          queryKey,
                                          buildLocalAlbumsResponse(localAlbums),
                                      );
                                  }
                                  logSearchUiHitSampled('albums', {
                                      localCount: localAlbums.length,
                                      ms: Math.round(performance.now() - t0),
                                      q: searchTerm,
                                  });
                              } catch (err) {
                                  console.warn(
                                      '[cache] search-ui: local lookup failed (albums)',
                                      err,
                                  );
                              }
                          })()
                        : undefined;

                const fresh = await api.controller.search({
                    apiClientProps: { serverId, signal },
                    query: {
                        albumArtistLimit: 0,
                        albumArtistStartIndex: 0,
                        albumLimit: SEARCH_PAGE_SIZE,
                        albumStartIndex: startIndex,
                        query: searchTerm,
                        songLimit: 0,
                        songStartIndex: 0,
                    },
                });

                if (localPromise) await localPromise;

                const existing = readSnapshot<InfiniteData<SearchResponse, number>>(queryKey);
                const pages = existing?.pages ? [...existing.pages] : [];
                const pageParams = existing?.pageParams ? [...existing.pageParams] : [];
                const idx = pageParams.findIndex((p) => p === startIndex);
                if (idx >= 0) {
                    pages[idx] = fresh;
                } else {
                    if (startIndex === 0 && pages.length === 1 && pageParams[0] === 0) {
                        pages[0] = fresh;
                    } else {
                        pages.push(fresh);
                        pageParams.push(startIndex);
                    }
                }
                writeSnapshot(queryKey, { pageParams, pages });

                return fresh;
            },
            queryKey,
        });
    },
    searchSongsInfinite: (args: {
        enabled?: boolean;
        searchTerm: string;
        serverId: string | undefined;
    }) => {
        const { enabled = true, searchTerm, serverId } = args;
        const queryKey = queryKeys.search.infiniteList(serverId ?? '', 'songs', searchTerm);
        return infiniteQueryOptions({
            enabled: Boolean(serverId && searchTerm && enabled),
            getNextPageParam: (lastPage: SearchResponse, allPages: SearchResponse[]) => {
                const len = lastPage.songs.length;
                if (len < SEARCH_PAGE_SIZE) return undefined;
                return allPages.length * SEARCH_PAGE_SIZE;
            },
            initialPageParam: 0,
            placeholderData: () => readSnapshot<InfiniteData<SearchResponse, number>>(queryKey),
            queryFn: async ({ pageParam, signal }) => {
                if (!serverId) throw new Error('serverId required');
                const startIndex = (pageParam ?? 0) as number;

                const localPromise =
                    startIndex === 0 && searchTerm.trim()
                        ? (async () => {
                              const t0 = performance.now();
                              try {
                                  const localSongs = await searchSongsLocal(
                                      searchTerm,
                                      SEARCH_PAGE_SIZE,
                                  );
                                  if (localSongs.length > 0) {
                                      seedSnapshotWithLocalPage(
                                          queryKey,
                                          buildLocalSongsResponse(localSongs),
                                      );
                                  }
                                  logSearchUiHitSampled('songs', {
                                      localCount: localSongs.length,
                                      ms: Math.round(performance.now() - t0),
                                      q: searchTerm,
                                  });
                              } catch (err) {
                                  console.warn(
                                      '[cache] search-ui: local lookup failed (songs)',
                                      err,
                                  );
                              }
                          })()
                        : undefined;

                const fresh = await api.controller.search({
                    apiClientProps: { serverId, signal },
                    query: {
                        albumArtistLimit: 0,
                        albumArtistStartIndex: 0,
                        albumLimit: 0,
                        albumStartIndex: 0,
                        query: searchTerm,
                        songLimit: SEARCH_PAGE_SIZE,
                        songStartIndex: startIndex,
                    },
                });

                if (localPromise) await localPromise;

                const existing = readSnapshot<InfiniteData<SearchResponse, number>>(queryKey);
                const pages = existing?.pages ? [...existing.pages] : [];
                const pageParams = existing?.pageParams ? [...existing.pageParams] : [];
                const idx = pageParams.findIndex((p) => p === startIndex);
                if (idx >= 0) {
                    pages[idx] = fresh;
                } else {
                    if (startIndex === 0 && pages.length === 1 && pageParams[0] === 0) {
                        pages[0] = fresh;
                    } else {
                        pages.push(fresh);
                        pageParams.push(startIndex);
                    }
                }
                writeSnapshot(queryKey, { pageParams, pages });

                return fresh;
            },
            queryKey,
        });
    },
};
