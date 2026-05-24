import { set } from 'idb-keyval';
import chunk from 'lodash/chunk';
import filter from 'lodash/filter';
import orderBy from 'lodash/orderBy';
import { z } from 'zod';

import { createAuthHeader, jfApiClient } from '/@/renderer/api/jellyfin/jellyfin-api';
import { useRadioStore } from '/@/renderer/features/radio/store/radio-store';
import { isShuffleEnabled, usePlayerStoreBase } from '/@/renderer/store/player.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';
import { jfNormalize } from '/@/shared/api/jellyfin/jellyfin-normalize';
import { JFSongListSort, JFSortOrder, jfType } from '/@/shared/api/jellyfin/jellyfin-types';
import { getFeatures, hasFeature, sortSongList, VersionInfo } from '/@/shared/api/utils';
import {
    albumArtistListSortMap,
    albumListSortMap,
    Folder,
    genreListSortMap,
    ImageArgs,
    ImageRequest,
    InternalControllerEndpoint,
    LibraryItem,
    Played,
    playlistListSortMap,
    ReplaceApiClientProps,
    ServerType,
    Song,
    SongListSort,
    songListSortMap,
    SortOrder,
    sortOrderMap,
    Tag,
} from '/@/shared/types/domain-types';
import { ServerFeature } from '/@/shared/types/features-types';

const getJellyfinImageRequest = ({
    apiClientProps: { server },
    baseUrl,
    query,
}: ReplaceApiClientProps<ImageArgs>): ImageRequest | null => {
    const { id, size } = query;
    const imageSize = size;

    if (!server) {
        return null;
    }

    const url = baseUrl || getServerUrl(server);

    if (!url) {
        return null;
    }

    return {
        cacheKey: ['jellyfin', server.id, baseUrl || '', id, imageSize || ''].join(':'),
        headers: server.credential
            ? { Authorization: createAuthHeader().concat(`, Token="${server.credential}"`) }
            : { Authorization: createAuthHeader() },
        url: `${url}/Items/${id}/Images/Primary?quality=96${imageSize ? `&width=${imageSize}` : ''}`,
    };
};

const formatCommaDelimitedString = (value: string[]) => {
    return value.join(',');
};

// Limit the query to 50 at a time to be *extremely* conservative on the
// length of the full URL, since the ids are part of the query string and
// not the POST body
const MAX_ITEMS_PER_PLAYLIST_ADD = 50;

// Defining a re-usable Collator instance for performance reasons.
const numericSortCollator = new Intl.Collator(undefined, { numeric: true });
const collator = new Intl.Collator();

const VERSION_INFO: VersionInfo = [
    [
        '10.9.0',
        {
            [ServerFeature.LYRICS_SINGLE_STRUCTURED]: [1],
            [ServerFeature.PUBLIC_PLAYLIST]: [1],
        },
    ],
    ['10.0.0', { [ServerFeature.TAGS]: [1] }],
];

export const JF_FIELDS = {
    ALBUM_ARTIST_DETAIL: ['Genres', 'Overview', 'SortName', 'ProviderIds'],
    ALBUM_ARTIST_LIST: [
        'Genres',
        'DateCreated',
        'ExternalUrls',
        'Overview',
        'SortName',
        'ProviderIds',
        // Required for SongCount/AlbumCount to be populated in the response.
        // Without this Jellyfin returns those fields as undefined and downstream
        // filters that depend on songCount (e.g. the featured-artist card's
        // minimum-track-count threshold) treat every artist as having 0 songs.
        'ItemCounts',
    ],
    ALBUM_DETAIL: ['Genres', 'DateCreated', 'ChildCount', 'People', 'Tags', 'ProviderIds', 'Path'],
    // GenreItems is required for genre IDs (not just names) to appear in the
    // normalized album.genres[].id — used by the *GenreIds Dexie index and
    // the filterAlbumsLocal genre filter. Genres (name-only) stays for
    // backwards-compat with any path that reads item.Genres directly.
    ALBUM_LIST: [
        'People',
        'Tags',
        'Studios',
        'SortName',
        'ProviderIds',
        'ChildCount',
        'Path',
        'Genres',
        'GenreItems',
    ],
    FOLDER: ['Genres', 'DateCreated', 'MediaSources', 'ParentId', 'Path'],
    GENRE: ['ItemCounts'],
    PLAYLIST_DETAIL: [
        'Genres',
        'DateCreated',
        'MediaSources',
        'ChildCount',
        'ParentId',
        'SortName',
    ],
    PLAYLIST_LIST: ['ChildCount', 'Genres', 'DateCreated', 'ParentId', 'Overview'],
    SONG: [
        'Genres',
        'DateCreated',
        'MediaSources',
        'ParentId',
        'People',
        'Tags',
        'SortName',
        'ProviderIds',
    ],
} as const;

export const JellyfinController: InternalControllerEndpoint = {
    addToPlaylist: async (args) => {
        const { apiClientProps, body, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const chunks = chunk(body.songId, MAX_ITEMS_PER_PLAYLIST_ADD);

        for (const chunk of chunks) {
            const res = await jfApiClient(apiClientProps).addToPlaylist({
                body: null,
                params: {
                    id: query.id,
                },
                query: {
                    Ids: chunk.join(','),
                    UserId: apiClientProps.server?.userId,
                },
            });

            if (res.status !== 204) {
                throw new Error('Failed to add to playlist');
            }
        }

        return null;
    },
    authenticate: async (url, body) => {
        const cleanServerUrl = url.replace(/\/$/, '');

        const res = await jfApiClient({ server: null, url: cleanServerUrl }).authenticate({
            body: {
                Pw: body.password,
                Username: body.username,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to authenticate');
        }

        return {
            credential: res.body.AccessToken,
            isAdmin: Boolean(res.body.User.Policy.IsAdministrator),
            userId: res.body.User.Id,
            username: res.body.User.Name,
        };
    },
    createFavorite: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        for (const id of query.id) {
            await jfApiClient(apiClientProps).createFavorite({
                body: {},
                params: {
                    id,
                    userId: apiClientProps.server?.userId,
                },
            });
        }

        return null;
    },
    createInternetRadioStation: async (args) => {
        const { apiClientProps, body } = args;

        if (!apiClientProps.serverId) {
            throw new Error('No serverId found');
        }

        const state = useRadioStore.getState();
        if (!state?.actions?.createStation) {
            throw new Error('Radio store not initialized');
        }

        state.actions.createStation(apiClientProps.serverId, {
            homepageUrl: body.homepageUrl || null,
            name: body.name,
            streamUrl: body.streamUrl,
        });

        return null;
    },
    createPlaylist: async (args) => {
        const { apiClientProps, body } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).createPlaylist({
            body: {
                IsPublic: body.public,
                MediaType: 'Audio',
                Name: body.name,
                UserId: apiClientProps.server.userId,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to create playlist');
        }

        return {
            id: res.body.Id,
        };
    },
    deleteFavorite: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        for (const id of query.id) {
            await jfApiClient(apiClientProps).removeFavorite({
                body: {},
                params: {
                    id,
                    userId: apiClientProps.server?.userId,
                },
            });
        }

        return null;
    },
    deleteInternetRadioStation: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.serverId) {
            throw new Error('No serverId found');
        }

        const state = useRadioStore.getState();
        if (!state?.actions?.deleteStation) {
            throw new Error('Radio store not initialized');
        }

        state.actions.deleteStation(apiClientProps.serverId, query.id);

        return null;
    },
    deletePlaylist: async (args) => {
        const { apiClientProps, query } = args;

        const res = await jfApiClient(apiClientProps).deletePlaylist({
            params: {
                id: query.id,
            },
        });

        if (res.status !== 204) {
            throw new Error('Failed to delete playlist');
        }

        return null;
    },
    getAlbumArtistDetail: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).getAlbumArtistDetail({
            params: {
                id: query.id,
                userId: apiClientProps.server?.userId,
            },
            query: {
                Fields: ['Genres', 'Overview', 'SortName'],
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get album artist detail');
        }

        return jfNormalize.albumArtist(res.body, apiClientProps.server);
    },
    getAlbumArtistInfo: async (args) => {
        const { apiClientProps, query } = args;

        const similarArtistsRes = await jfApiClient(apiClientProps).getSimilarArtistList({
            params: {
                id: query.id,
            },
            query: {
                Limit: query.limit ?? 10,
            },
        });

        if (similarArtistsRes.status !== 200) {
            return null;
        }

        const items = similarArtistsRes.body?.Items?.filter(
            (entry) => entry.Name !== 'Various Artists',
        );
        const similarArtists =
            items?.map((entry) => ({
                id: entry.Id,
                imageId: entry.ImageTags?.Primary ? entry.Id : null,
                imageUrl: null,
                name: entry.Name,
                userFavorite: entry.UserData?.IsFavorite || false,
                userRating: null,
            })) ?? null;

        return {
            similarArtists,
        };
    },
    getAlbumArtistList: async (args) => {
        const { apiClientProps, query } = args;

        const res = await jfApiClient(apiClientProps).getAlbumArtistList({
            query: {
                Fields: JF_FIELDS.ALBUM_ARTIST_LIST,
                ImageTypeLimit: 1,
                IsFavorite: query.favorite,
                Limit: query.limit,
                ParentId: getLibraryId(query.musicFolderId),
                Recursive: true,
                SearchTerm: query.searchTerm,
                SortBy: albumArtistListSortMap.jellyfin[query.sortBy] || 'SortName,Name',
                SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                StartIndex: query.startIndex,
                UserId: apiClientProps.server?.userId || undefined,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get album artist list');
        }

        return {
            items: res.body.Items.map((item) =>
                jfNormalize.albumArtist(item, apiClientProps.server),
            ),
            startIndex: query.startIndex,
            totalRecordCount: res.body.TotalRecordCount,
        };
    },
    getAlbumArtistListCount: async ({ apiClientProps, query }) =>
        JellyfinController.getAlbumArtistList({
            apiClientProps,
            query: { ...query, limit: 1, startIndex: 0 },
        }).then((result) => result!.totalRecordCount!),
    getAlbumDetail: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).getAlbumDetail({
            params: {
                id: query.id,
                userId: apiClientProps.server.userId,
            },
            query: {
                Fields: JF_FIELDS.ALBUM_DETAIL,
            },
        });

        // Use ParentId to enumerate the album's direct audio children.
        //
        // Upstream commit f190626c switched this to AlbumIds + Recursive to
        // make play counts come through, but on certain Jellyfin libraries
        // that combination returns only a tiny subset of the album (we saw
        // a 368-track album come back as one song repeated twice). Going
        // back to ParentId restores the original "give me the children of
        // this album" semantics, and we add EnableUserData + UserId
        // explicitly so the play-count fix from the upstream commit still
        // applies.
        const songsRes = await jfApiClient(apiClientProps).getSongList({
            params: {
                userId: apiClientProps.server.userId,
            },
            query: {
                EnableUserData: true,
                Fields: JF_FIELDS.SONG,
                IncludeItemTypes: 'Audio',
                // Pin a large explicit Limit so albums with > the server's
                // default page size still come back in full.
                Limit: 5000,
                ParentId: query.id,
                SortBy: 'ParentIndexNumber,IndexNumber,SortName',
                SortOrder: JFSortOrder.ASC,
                StartIndex: 0,
                UserId: apiClientProps.server.userId,
            },
        });

        if (res.status !== 200 || songsRes.status !== 200) {
            throw new Error('Failed to get album detail');
        }

        // Defensive de-dup. ParentId-children responses don't normally
        // duplicate, but keeping this is cheap insurance for any edge case
        // where a song surfaces twice in the same album listing.
        const seenSongIds = new Set<string>();
        const uniqueSongs = songsRes.body.Items.filter((song) => {
            if (seenSongIds.has(song.Id)) return false;
            seenSongIds.add(song.Id);
            return true;
        });

        return jfNormalize.album(
            { ...res.body, Songs: uniqueSongs },
            apiClientProps.server,
            args.context?.pathReplace,
            args.context?.pathReplaceWith,
        );
    },
    getAlbumList: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const yearsGroup: string[] = [];
        if (query.minYear && query.maxYear) {
            for (let i = Number(query.minYear); i <= Number(query.maxYear); i += 1) {
                yearsGroup.push(String(i));
            }
        }

        const yearsFilter = yearsGroup.length ? yearsGroup.join(',') : undefined;

        let artistQuery:
            | Omit<z.infer<typeof jfType._parameters.albumList>, 'IncludeItemTypes'>
            | undefined;

        if (query.artistIds) {
            // Based mostly off of observation, this is the behavior I've seen:
            // ContributingArtistIds is the _closest_ to where the album is a compilation and the artist is involved
            // AlbumArtistIds is where the artist is an album artist
            // ArtistIds is all credits
            if (query.compilation) {
                artistQuery = {
                    ContributingArtistIds: formatCommaDelimitedString(query.artistIds),
                };
            } else if (query.compilation === false) {
                artistQuery = { AlbumArtistIds: formatCommaDelimitedString(query.artistIds) };
            } else {
                artistQuery = { ArtistIds: formatCommaDelimitedString(query.artistIds) };
            }
        }

        const res = await jfApiClient(apiClientProps).getAlbumList({
            params: {
                userId: apiClientProps.server?.userId,
            },
            query: {
                ...artistQuery,
                Fields: JF_FIELDS.ALBUM_LIST,
                GenreIds: query.genreIds ? query.genreIds.join(',') : undefined,
                IncludeItemTypes: 'MusicAlbum',
                IsFavorite: query.favorite,
                Limit: query.limit === -1 ? undefined : query.limit,
                ParentId: getLibraryId(query.musicFolderId),
                Recursive: true,
                SearchTerm: query.searchTerm,
                SortBy: albumListSortMap.jellyfin[query.sortBy] || 'SortName',
                SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                StartIndex: query.startIndex,
                ...query._custom,
                Years: yearsFilter,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get album list');
        }

        return {
            items: res.body.Items.map((item) => jfNormalize.album(item, apiClientProps.server)),
            startIndex: query.startIndex,
            totalRecordCount: res.body.TotalRecordCount,
        };
    },
    getAlbumListCount: async ({ apiClientProps, query }) =>
        JellyfinController.getAlbumList({
            apiClientProps,
            query: { ...query, limit: 1, startIndex: 0 },
        }).then((result) => result!.totalRecordCount!),
    getAlbumRadio: async (args) => {
        const { apiClientProps, query } = args;

        // For Jellyfin, use instant mix for album radio
        const res = await jfApiClient(apiClientProps).getInstantMix({
            params: {
                itemId: query.albumId,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                Limit: query.count,
                UserId: apiClientProps.server?.userId || undefined,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get album radio songs');
        }

        return res.body.Items.map((song) =>
            jfNormalize.song(
                song,
                apiClientProps.server,
                args.context?.pathReplace,
                args.context?.pathReplaceWith,
            ),
        );
    },
    getArtistList: async (args) => {
        const { apiClientProps, query } = args;

        const res = await jfApiClient(apiClientProps).getArtistList({
            query: {
                Fields: JF_FIELDS.ALBUM_ARTIST_LIST,
                ImageTypeLimit: 1,
                Limit: query.limit,
                ParentId: getLibraryId(query.musicFolderId),
                Recursive: true,
                SearchTerm: query.searchTerm,
                SortBy: albumArtistListSortMap.jellyfin[query.sortBy] || 'SortName,Name',
                SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                StartIndex: query.startIndex,
                UserId: apiClientProps.server?.userId || undefined,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get album artist list');
        }

        return {
            items: res.body.Items.map((item) =>
                jfNormalize.albumArtist(item, apiClientProps.server),
            ),
            startIndex: query.startIndex,
            totalRecordCount: res.body.TotalRecordCount,
        };
    },
    getArtistListCount: async ({ apiClientProps, query }) =>
        JellyfinController.getArtistList({
            apiClientProps,
            query: { ...query, limit: 1, startIndex: 0 },
        }).then((result) => result!.totalRecordCount!),
    getArtistRadio: async (args) => {
        const { apiClientProps, query } = args;

        // For Jellyfin, use instant mix for artist radio
        const res = await jfApiClient(apiClientProps).getInstantMix({
            params: {
                itemId: query.artistId,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                Limit: query.count,
                UserId: apiClientProps.server?.userId || undefined,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get artist radio songs');
        }

        return res.body.Items.map((song) =>
            jfNormalize.song(
                song,
                apiClientProps.server,
                args.context?.pathReplace,
                args.context?.pathReplaceWith,
            ),
        );
    },
    getDownloadUrl: (args) => {
        const { apiClientProps, query } = args;

        return `${apiClientProps.server?.url}/items/${query.id}/download?apiKey=${apiClientProps.server?.credential}`;
    },
    getFolder: async (args) => {
        const { apiClientProps, query } = args;
        const userId = apiClientProps.server?.userId;

        if (!userId) throw new Error('No userId found');

        const sortOrder = (query.sortOrder?.toLowerCase() ?? 'asc') as 'asc' | 'desc';
        const isRootFolderId = query.id === '0';

        if (isRootFolderId) {
            if (query.musicFolderId) {
                // If music folder is provided, directly get the folder
                const musicFolderRes = await jfApiClient(apiClientProps).getFolder({
                    params: {
                        userId,
                    },
                    query: {
                        ParentId: getLibraryId(query.musicFolderId)!,
                    },
                });

                if (musicFolderRes.status !== 200) {
                    throw new Error('Failed to get music folder list');
                }

                let items = musicFolderRes.body.Items.filter((item) => item.Type !== 'Audio');

                if (query.searchTerm) {
                    items = filter(items, (item) => {
                        return item.Name.toLowerCase().includes(query.searchTerm!.toLowerCase());
                    });
                }

                const folders = items
                    .filter((item) => item.Type !== 'Audio')
                    .map((item) =>
                        jfNormalize.folder(
                            item,
                            apiClientProps.server,
                            args.context?.pathReplace,
                            args.context?.pathReplaceWith,
                        ),
                    );

                const sortedFolders = orderBy(folders, [(v) => v.name.toLowerCase()], [sortOrder]);

                return {
                    _itemType: LibraryItem.FOLDER,
                    _serverId: apiClientProps.server?.id || 'unknown',
                    _serverType: ServerType.JELLYFIN,
                    children: {
                        folders: sortedFolders,
                        songs: [],
                    },
                    id: query.id,
                    name: '~',
                    parentId: undefined,
                };
            } else {
                // Use the root music folder list if no music folder id is provided
                const musicFolderRes = await jfApiClient(apiClientProps).getMusicFolderList({
                    params: {
                        userId,
                    },
                });

                if (musicFolderRes.status !== 200) {
                    throw new Error('Failed to get music folder list');
                }

                let items = musicFolderRes.body.Items.filter((item) => item.Type !== 'Audio');

                if (query.searchTerm) {
                    items = filter(items, (item) => {
                        return item.Name.toLowerCase().includes(query.searchTerm!.toLowerCase());
                    });
                }

                const folders = items
                    .filter((item) => item.Type !== 'Audio')
                    .map((item) =>
                        jfNormalize.folder(
                            item as unknown as z.infer<typeof jfType._response.folder>,
                            apiClientProps.server,
                            args.context?.pathReplace,
                            args.context?.pathReplaceWith,
                        ),
                    );

                const sortedFolders = orderBy(folders, [(v) => v.name.toLowerCase()], [sortOrder]);

                return {
                    _itemType: LibraryItem.FOLDER,
                    _serverId: apiClientProps.server?.id || 'unknown',
                    _serverType: ServerType.JELLYFIN,
                    children: {
                        folders: sortedFolders,
                        songs: [],
                    },
                    id: query.id,
                    name: '~',
                    parentId: undefined,
                };
            }
        }

        const folderDetailRes = await jfApiClient(apiClientProps).getFolder({
            params: {
                userId,
            },
            query: {
                Fields: JF_FIELDS.FOLDER,
                ParentId: query.id,
                SortBy: query.sortBy
                    ? (songListSortMap.jellyfin[query.sortBy] as string) || 'SortName'
                    : 'SortName',
                SortOrder: sortOrderMap.jellyfin[query.sortOrder || SortOrder.ASC],
            },
        });

        if (folderDetailRes.status !== 200) {
            throw new Error('Failed to get folder');
        }

        // Get parent folder info - we'll use the first child's ParentId to infer the folder's parentId
        // The folder name will be inferred from the query.id or we can try to get it from a parent query
        let parentId: string | undefined;
        let folderName = 'Unknown folder';

        if (folderDetailRes.body.Items?.length > 0) {
            const firstItem = folderDetailRes.body.Items[0];
            parentId = firstItem.ParentId;

            // Try to get the folder name by querying its parent's children
            if (parentId) {
                const parentFolderRes = await jfApiClient(apiClientProps).getFolder({
                    params: {
                        userId,
                    },
                    query: {
                        Fields: JF_FIELDS.FOLDER,
                        ParentId: parentId,
                    },
                });

                if (parentFolderRes.status === 200) {
                    const parentFolderItem = parentFolderRes.body.Items?.find(
                        (item) => item.Id === query.id,
                    );
                    if (parentFolderItem) {
                        folderName = parentFolderItem.Name || 'Unknown folder';
                        parentId = parentFolderItem.ParentId;
                    }
                }
            }
        }

        const items = folderDetailRes.body.Items || [];

        let filteredFolders = items
            .filter((item) => item.Type !== 'Audio')
            .map((item) =>
                jfNormalize.folder(
                    item,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            );
        let filteredSongs = items
            .filter(
                (item) =>
                    item.Type === 'Audio' &&
                    (item as unknown as z.infer<typeof jfType._response.song>).MediaSources,
            )
            .map((item) =>
                jfNormalize.song(
                    item as unknown as z.infer<typeof jfType._response.song>,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            );

        if (query.searchTerm) {
            const searchTermLower = query.searchTerm.toLowerCase();
            filteredFolders = filter(filteredFolders, (f) =>
                f.name.toLowerCase().includes(searchTermLower),
            );
            filteredSongs = filter(filteredSongs, (s) => {
                const name = s.name?.toLowerCase() || '';
                const album = s.album?.toLowerCase() || '';
                const artist = s.artistName?.toLowerCase() || '';
                return (
                    name.includes(searchTermLower) ||
                    album.includes(searchTermLower) ||
                    artist.includes(searchTermLower)
                );
            });
        }

        filteredFolders = orderBy(filteredFolders, [(v) => v.name.toLowerCase()], [sortOrder]);

        if (filteredSongs.length > 0) {
            filteredSongs = sortSongList(
                filteredSongs,
                query.sortBy || SongListSort.NAME,
                query.sortOrder || SortOrder.ASC,
            );
        }

        const folder: Folder = {
            _itemType: LibraryItem.FOLDER,
            _serverId: apiClientProps.server?.id || 'unknown',
            _serverType: ServerType.JELLYFIN,
            children: {
                folders: filteredFolders,
                songs: filteredSongs,
            },
            id: query.id,
            name: folderName,
            parentId,
        };

        return folder;
    },
    getFolderSongsRecursive: async (args) => {
        const { apiClientProps, query } = args;
        const userId = apiClientProps.server?.userId;

        if (!userId) throw new Error('No userId found');

        const res = await jfApiClient(apiClientProps).getFolder({
            params: {
                userId,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                IncludeItemTypes: 'Audio',
                ParentId: query.folderId,
                Recursive: true,
                SortBy: 'ParentIndexNumber,IndexNumber,SortName',
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get folder songs');
        }

        const items = res.body.Items || [];

        return items
            .filter((item) => item.Type === 'Audio')
            .map((item) =>
                jfNormalize.song(
                    item as unknown as z.infer<typeof jfType._response.song>,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            );
    },
    getGenreList: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).getGenreList({
            query: {
                EnableTotalRecordCount: true,
                Fields: JF_FIELDS.GENRE,
                Limit: query.limit === -1 ? undefined : query.limit,
                ParentId: getLibraryId(query.musicFolderId),
                Recursive: true,
                SearchTerm: query?.searchTerm,
                SortBy: genreListSortMap.jellyfin[query.sortBy] || 'SortName',
                SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                StartIndex: query.startIndex,
                UserId: apiClientProps.server?.userId,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get genre list');
        }

        return {
            items: res.body.Items.map((item) => jfNormalize.genre(item, apiClientProps.server)),
            startIndex: query.startIndex || 0,
            totalRecordCount: res.body?.TotalRecordCount || 0,
        };
    },
    getImageRequest: getJellyfinImageRequest,
    getImageUrl: (args) => getJellyfinImageRequest(args)?.url || null,
    getInternetRadioStations: async (args) => {
        const { apiClientProps } = args;

        if (!apiClientProps.serverId) {
            throw new Error('No serverId found');
        }

        const state = useRadioStore.getState();
        if (!state?.actions?.getStations) {
            throw new Error('Radio store not initialized');
        }

        return state.actions.getStations(apiClientProps.serverId);
    },
    getLyrics: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).getSongLyrics({
            params: {
                id: query.songId,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get lyrics');
        }

        if (res.body.Lyrics.length > 0 && res.body.Lyrics[0].Start === undefined) {
            return res.body.Lyrics.map((lyric) => lyric.Text).join('\n');
        }

        return res.body.Lyrics.map((lyric) => [lyric.Start! / 1e4, lyric.Text]);
    },
    getMusicFolderList: async (args) => {
        const { apiClientProps } = args;
        const userId = apiClientProps.server?.userId;

        if (!userId) throw new Error('No userId found');

        const res = await jfApiClient(apiClientProps).getMusicFolderList({
            params: {
                userId,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get genre list');
        }

        const musicFolders = res.body.Items.filter(
            (folder) => folder.CollectionType === jfType._enum.collection.MUSIC,
        );

        return {
            items: musicFolders.map(jfNormalize.musicFolder),
            startIndex: 0,
            totalRecordCount: musicFolders?.length || 0,
        };
    },
    getPlaylistDetail: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).getPlaylistDetail({
            params: {
                id: query.id,
                userId: apiClientProps.server?.userId,
            },
            query: {
                Fields: JF_FIELDS.PLAYLIST_DETAIL,
                Ids: query.id,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get playlist detail');
        }

        return jfNormalize.playlist(res.body, apiClientProps.server);
    },
    getPlaylistList: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).getPlaylistList({
            params: {
                userId: apiClientProps.server?.userId,
            },
            query: {
                Fields: JF_FIELDS.PLAYLIST_LIST,
                IncludeItemTypes: 'Playlist',
                Limit: query.limit,
                // MediaTypes:Audio causes Jellyfin to report a non-zero
                // TotalRecordCount but return Items:[] — playlists are
                // containers, not media items, so filtering by media type
                // produces this mismatch. Omit it to get correct results.
                Recursive: true,
                SearchTerm: query.searchTerm,
                SortBy: playlistListSortMap.jellyfin[query.sortBy],
                SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                StartIndex: query.startIndex,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get playlist list');
        }

        return {
            items: res.body.Items.map((item) => jfNormalize.playlist(item, apiClientProps.server)),
            startIndex: 0,
            totalRecordCount: res.body.TotalRecordCount,
        };
    },
    getPlaylistListCount: async ({ apiClientProps, query }) =>
        JellyfinController.getPlaylistList({
            apiClientProps,
            query: { ...query, limit: 1, startIndex: 0 },
        }).then((result) => result!.totalRecordCount!),
    getPlaylistSongList: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        // Pass an explicit large Limit so we always get the whole playlist
        // back. Jellyfin's documented default is "no limit" for this endpoint,
        // but some server configurations cap responses to a small page size,
        // which would leave the queue with only the first few tracks of the
        // playlist after a user clicks "play" on it.
        const res = await jfApiClient(apiClientProps).getPlaylistSongList({
            params: {
                id: query.id,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                IncludeItemTypes: 'Audio',
                Limit: query.limit ?? 5000,
                StartIndex: query.startIndex ?? 0,
                UserId: apiClientProps.server?.userId,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get playlist song list');
        }

        return {
            items: res.body.Items.map((item) =>
                jfNormalize.song(
                    item,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            ),
            startIndex: 0,
            totalRecordCount: res.body.TotalRecordCount,
        };
    },
    getPlayQueue: async () => {
        throw new Error('Not supported');
    },
    getRandomSongList: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const yearsGroup: string[] = [];
        if (query.minYear && query.maxYear) {
            for (let i = Number(query.minYear); i <= Number(query.maxYear); i += 1) {
                yearsGroup.push(String(i));
            }
        }

        const yearsFilter = yearsGroup.length ? formatCommaDelimitedString(yearsGroup) : undefined;

        const res = await jfApiClient(apiClientProps).getSongList({
            params: {
                userId: apiClientProps.server?.userId,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                GenreIds: query.genre ? query.genre : undefined,
                IncludeItemTypes: 'Audio',
                IsPlayed:
                    query.played === Played.Never
                        ? false
                        : query.played === Played.Played
                          ? true
                          : undefined,
                Limit: query.limit,
                ParentId: getLibraryId(query.musicFolderId),
                Recursive: true,
                SortBy: JFSongListSort.RANDOM,
                SortOrder: JFSortOrder.ASC,
                StartIndex: 0,
                Years: yearsFilter,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get random songs');
        }

        return {
            items: res.body.Items.map((item) =>
                jfNormalize.song(
                    item,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            ),
            startIndex: 0,
            totalRecordCount: res.body.Items.length || 0,
        };
    },
    getRoles: async () => [],
    getServerInfo: async (args) => {
        const { apiClientProps } = args;

        const res = await jfApiClient(apiClientProps).getServerInfo();

        if (res.status !== 200) {
            throw new Error('Failed to get server info');
        }

        const defaultFeatures = {};

        const features = {
            ...defaultFeatures,
            ...getFeatures(VERSION_INFO, res.body.Version),
        };

        return {
            features,
            id: apiClientProps.server?.id,
            version: res.body.Version,
        };
    },
    getSimilarSongs: async (args) => {
        const { apiClientProps, query } = args;

        if (apiClientProps.server?.preferInstantMix !== true) {
            // Prefer getSimilarSongs, where possible, and not overridden.
            // InstantMix can be overridden by plugins, so this may be preferred by the user.
            // Otherwise, similarSongs may have a better output than InstantMix, if sufficient
            // data exists from the server.
            const res = await jfApiClient(apiClientProps).getSimilarSongs({
                params: {
                    itemId: query.songId,
                },
                query: {
                    Fields: JF_FIELDS.SONG,
                    Limit: query.count,
                    UserId: apiClientProps.server?.userId || undefined,
                },
            });

            if (res.status === 200 && res.body.Items.length) {
                const results = res.body.Items.reduce<Song[]>((acc, song) => {
                    if (song.Id !== query.songId) {
                        acc.push(
                            jfNormalize.song(
                                song,
                                apiClientProps.server,
                                args.context?.pathReplace,
                                args.context?.pathReplaceWith,
                            ),
                        );
                    }

                    return acc;
                }, []);

                if (results.length > 0) {
                    return results;
                }
            }
        }

        const mix = await jfApiClient(apiClientProps).getInstantMix({
            params: {
                itemId: query.songId,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                Limit: query.count,
                UserId: apiClientProps.server?.userId || undefined,
            },
        });

        if (mix.status !== 200) {
            throw new Error('Failed to get similar songs');
        }

        return mix.body.Items.reduce<Song[]>((acc, song) => {
            if (song.Id !== query.songId) {
                acc.push(
                    jfNormalize.song(
                        song,
                        apiClientProps.server,
                        args.context?.pathReplace,
                        args.context?.pathReplaceWith,
                    ),
                );
            }

            return acc;
        }, []);
    },
    getSongDetail: async (args) => {
        const { apiClientProps, query } = args;

        const res = await jfApiClient(apiClientProps).getSongDetail({
            params: {
                id: query.id,
                userId: apiClientProps.server?.userId ?? '',
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get song detail');
        }

        return jfNormalize.song(
            res.body,
            apiClientProps.server,
            args.context?.pathReplace,
            args.context?.pathReplaceWith,
        );
    },
    getSongList: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const yearsGroup: string[] = [];
        if (query.minYear && query.maxYear) {
            for (let i = Number(query.minYear); i <= Number(query.maxYear); i += 1) {
                yearsGroup.push(String(i));
            }
        }

        const yearsFilter = yearsGroup.length ? formatCommaDelimitedString(yearsGroup) : undefined;
        const artistIdsFilter = query.artistIds
            ? formatCommaDelimitedString(query.artistIds)
            : query.albumArtistIds
              ? formatCommaDelimitedString(query.albumArtistIds)
              : undefined;

        let items: z.infer<typeof jfType._response.song>[] = [];
        let totalRecordCount = 0;
        const batchSize = 50;

        // Handle albumIds fetches in batches to prevent HTTP 414 errors
        if (query.albumIds && query.albumIds.length > batchSize) {
            const albumIdBatches = chunk(query.albumIds, batchSize);

            for (const batch of albumIdBatches) {
                const albumIdsFilter = formatCommaDelimitedString(batch);

                const res = await jfApiClient(apiClientProps).getSongList({
                    params: {
                        userId: apiClientProps.server?.userId,
                    },
                    query: {
                        AlbumIds: albumIdsFilter,
                        ArtistIds: artistIdsFilter,
                        Fields: JF_FIELDS.SONG,
                        GenreIds: query.genreIds?.join(','),
                        IncludeItemTypes: 'Audio',
                        IsFavorite: query.favorite,
                        Limit: query.limit === -1 ? undefined : query.limit,
                        ParentId: getLibraryId(query.musicFolderId),
                        Recursive: true,
                        SearchTerm: query.searchTerm,
                        SortBy: songListSortMap.jellyfin[query.sortBy] || 'Album,SortName',
                        SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                        StartIndex: query.startIndex,
                        ...query._custom,
                        Years: yearsFilter,
                    },
                });

                if (res.status !== 200) {
                    throw new Error('Failed to get song list');
                }

                items = [...items, ...res.body.Items];
                totalRecordCount += res.body.Items.length;
            }
        } else {
            const albumIdsFilter = query.albumIds
                ? formatCommaDelimitedString(query.albumIds)
                : undefined;

            const res = await jfApiClient(apiClientProps).getSongList({
                params: {
                    userId: apiClientProps.server?.userId,
                },
                query: {
                    AlbumIds: albumIdsFilter,
                    ArtistIds: artistIdsFilter,
                    Fields: JF_FIELDS.SONG,
                    GenreIds: query.genreIds?.join(','),
                    IncludeItemTypes: 'Audio',
                    IsFavorite: query.favorite,
                    Limit: query.limit === -1 ? undefined : query.limit,
                    ParentId: getLibraryId(query.musicFolderId),
                    Recursive: true,
                    SearchTerm: query.searchTerm,
                    SortBy: songListSortMap.jellyfin[query.sortBy] || 'Album,SortName',
                    SortOrder: sortOrderMap.jellyfin[query.sortOrder],
                    StartIndex: query.startIndex,
                    ...query._custom,
                    Years: yearsFilter,
                },
            });

            if (res.status !== 200) {
                throw new Error('Failed to get song list');
            }

            // Jellyfin Bodge because of code from https://github.com/jellyfin/jellyfin/blob/c566ccb63bf61f9c36743ddb2108a57c65a2519b/Emby.Server.Implementations/Data/SqliteItemRepository.cs#L3622
            // If the Album ID filter is passed, Jellyfin will search for
            //  1. the matching album id
            //  2. An album with the name of the album.
            // It is this second condition causing issues,
            if (query.albumIds) {
                const albumIdSet = new Set(query.albumIds);
                items = res.body.Items.filter((item) => albumIdSet.has(item.AlbumId!));
                totalRecordCount = items.length;
            } else {
                items = res.body.Items;
                totalRecordCount = res.body.TotalRecordCount;
            }
        }

        return {
            items: items.map((item) =>
                jfNormalize.song(
                    item,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            ),
            startIndex: query.startIndex,
            totalRecordCount,
        };
    },
    getSongListCount: async ({ apiClientProps, query }) =>
        JellyfinController.getSongList({
            apiClientProps,
            query: { ...query, limit: 1, startIndex: 0 },
        }).then((result) => result!.totalRecordCount!),
    getStreamUrl: async ({ apiClientProps: { server }, query }) => {
        const { bitrate, format, id, transcode } = query;
        const deviceId = '';

        let url = `${server?.url}/Items/${id}/Download?apiKey=${server?.credential}&playSessionId=${deviceId}`;

        if (transcode) {
            // Some format appears to be required. Fall back to trusty MP3 if not specified
            // Otherwise, ffmpeg appears to crash
            const realFormat = format || 'mp3';

            url =
                `${server?.url}/audio` +
                `/${id}/universal` +
                `?userId=${server?.userId}` +
                `&deviceId=${deviceId}` +
                '&audioCodec=aac' +
                `&apiKey=${server?.credential}` +
                `&playSessionId=${deviceId}` +
                '&container=opus,mp3,aac,m4a,m4b,flac,wav,ogg';

            url += `&transcodingProtocol=http&transcodingContainer=${realFormat}`;
            url = url.replace('audioCodec=aac', `audioCodec=${realFormat}`);
            url = url.replace(
                '&container=opus,mp3,aac,m4a,m4b,flac,wav,ogg',
                `&container=${realFormat}`,
            );

            if (bitrate !== undefined) {
                url += `&maxStreamingBitrate=${bitrate * 1000}`;
            }
        }

        return url;
    },
    getTagList: async (args) => {
        const { apiClientProps, query } = args;

        if (!hasFeature(apiClientProps.server, ServerFeature.TAGS)) {
            return { boolTags: undefined, enumTags: undefined, excluded: { album: [], song: [] } };
        }

        const res = await jfApiClient(apiClientProps).getFilterList({
            query: {
                IncludeItemTypes: query.type === LibraryItem.SONG ? 'Audio' : 'MusicAlbum',
                ParentId: query.folder,
                UserId: apiClientProps.server?.userId ?? '',
            },
        });

        if (res.status !== 200) {
            throw new Error('failed to get tags');
        }

        const studioRes = await jfApiClient(apiClientProps).getStudioList({
            query: {
                EnableTotalRecordCount: true,
                IncludeItemTypes: query.type === LibraryItem.SONG ? 'Audio' : 'MusicAlbum',
                ParentId: query.folder,
            },
        });

        if (studioRes.status !== 200) {
            throw new Error('failed to get studios');
        }

        const tags: Tag[] = [];
        if (res.body.Tags?.length) {
            tags.push({
                name: 'Tags',
                options: res.body.Tags.sort((a, b) => {
                    return numericSortCollator.compare(
                        a.toLocaleLowerCase(),
                        b.toLocaleLowerCase(),
                    );
                }).map((tag) => ({ id: tag, name: tag })),
            });
        }

        if (studioRes.body.Items.length) {
            tags.push({
                name: 'Studios',
                options: studioRes.body.Items.sort((a, b) =>
                    collator.compare(a.Name.toLocaleLowerCase(), b.Name.toLocaleLowerCase()),
                ).map((option) => ({ id: option.Name, name: option.Name })),
            });
        }

        return { excluded: { album: [], song: [] }, tags };
    },
    getTopSongs: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const type = query.type === 'personal' ? 'personal' : 'community';

        const res = await jfApiClient(apiClientProps).getTopSongsList({
            params: {
                userId: apiClientProps.server?.userId,
            },
            query: {
                ArtistIds: query.artistId,
                Fields: JF_FIELDS.SONG,
                IncludeItemTypes: 'Audio',
                Limit: query.limit,
                Recursive: true,
                SortBy:
                    type === 'personal'
                        ? JFSongListSort.PLAY_COUNT
                        : JFSongListSort.COMMUNITY_RATING,
                SortOrder: 'Descending',
                UserId: apiClientProps.server?.userId,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get top song list');
        }

        const items = res.body.Items.map((item) =>
            jfNormalize.song(
                item,
                apiClientProps.server,
                args.context?.pathReplace,
                args.context?.pathReplaceWith,
            ),
        );

        if (type === 'personal') {
            const sorted = orderBy(
                items,
                ['playCount', 'albumId', 'trackNumber'],
                ['desc', 'asc', 'asc'],
            );

            return {
                items: sorted,
                startIndex: 0,
                totalRecordCount: res.body.TotalRecordCount,
            };
        }

        return {
            items,
            startIndex: 0,
            totalRecordCount: res.body.TotalRecordCount,
        };
    },
    getUserInfo: async (args) => {
        const { apiClientProps, query } = args;

        const res = await jfApiClient(apiClientProps).getUser({
            params: {
                id: query.id,
            },
        });

        if (res.status !== 200) {
            throw new Error('Failed to get user info');
        }

        return {
            id: res.body.Id,
            isAdmin: Boolean(res.body.Policy.IsAdministrator),
            name: res.body.Name,
        };
    },
    movePlaylistItem: async (args) => {
        const { apiClientProps, query } = args;

        const res = await jfApiClient(apiClientProps).movePlaylistItem({
            params: {
                itemId: query.trackId,
                newIdx: query.endingIndex.toString(),
                playlistId: query.playlistId,
            },
        });

        if (res.status !== 204) {
            throw new Error('Failed to move item in playlist');
        }
    },
    removeFromPlaylist: async (args) => {
        const { apiClientProps, query } = args;

        const chunks = chunk(query.songId, MAX_ITEMS_PER_PLAYLIST_ADD);

        for (const chunk of chunks) {
            const res = await jfApiClient(apiClientProps).removeFromPlaylist({
                params: {
                    id: query.id,
                },
                query: {
                    EntryIds: chunk.join(','),
                },
            });

            if (res.status !== 204) {
                throw new Error('Failed to remove from playlist');
            }
        }

        return null;
    },
    replacePlaylist: async (args) => {
        const { apiClientProps, body, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        // 1. Fetch existing songs from the playlist
        const existingSongsRes = await jfApiClient(apiClientProps).getPlaylistSongList({
            params: {
                id: query.id,
            },
            query: {
                Fields: JF_FIELDS.SONG,
                IncludeItemTypes: 'Audio',
                UserId: apiClientProps.server?.userId,
            },
        });

        if (existingSongsRes.status !== 200) {
            throw new Error('Failed to fetch existing playlist songs');
        }

        const existingSongs = existingSongsRes.body.Items.map((item) =>
            jfNormalize.song(
                item,
                apiClientProps.server,
                args.context?.pathReplace,
                args.context?.pathReplaceWith,
            ),
        );

        // 2. Get playlist detail to get the name
        const playlistDetailRes = await jfApiClient(apiClientProps).getPlaylistDetail({
            params: {
                id: query.id,
                userId: apiClientProps.server?.userId,
            },
            query: {
                Fields: JF_FIELDS.PLAYLIST_DETAIL,
                Ids: query.id,
            },
        });

        if (playlistDetailRes.status !== 200) {
            throw new Error('Failed to get playlist detail');
        }

        const playlist = jfNormalize.playlist(playlistDetailRes.body, apiClientProps.server);

        // 3. Make a backup of the playlist ids and their order, along with the id of the playlist and name
        const backup = {
            id: query.id,
            name: playlist.name,
            songIds: existingSongs.map((song) => song.id),
            timestamp: Date.now(),
        };

        // Store backup in IndexedDB using idb-keyval
        const backupKey = `playlist-backup-${query.id}`;
        await set(backupKey, backup);

        // 4. Remove all songs from the playlist
        if (existingSongs.length > 0) {
            const existingPlaylistItemIds = existingSongs
                .map((song) => song.playlistItemId)
                .filter((id): id is string => id !== undefined && id !== null);

            if (existingPlaylistItemIds.length > 0) {
                const chunks = chunk(existingPlaylistItemIds, MAX_ITEMS_PER_PLAYLIST_ADD);

                for (const chunk of chunks) {
                    const removeRes = await jfApiClient(apiClientProps).removeFromPlaylist({
                        params: {
                            id: query.id,
                        },
                        query: {
                            EntryIds: chunk.join(','),
                        },
                    });

                    if (removeRes.status !== 204) {
                        throw new Error('Failed to remove songs from playlist');
                    }
                }
            }
        }

        // 5. Add the new song ids to the playlist
        if (body.songId.length > 0) {
            const chunks = chunk(body.songId, MAX_ITEMS_PER_PLAYLIST_ADD);

            for (const chunk of chunks) {
                const addRes = await jfApiClient(apiClientProps).addToPlaylist({
                    body: null,
                    params: {
                        id: query.id,
                    },
                    query: {
                        Ids: chunk.join(','),
                        UserId: apiClientProps.server?.userId,
                    },
                });

                if (addRes.status !== 204) {
                    throw new Error('Failed to add songs to playlist');
                }
            }
        }

        return null;
    },
    savePlayQueue: async () => {
        throw new Error('Not supported');
    },
    scrobble: async (args) => {
        const { apiClientProps, query } = args;

        const position = query.position && Math.round(query.position);

        // Build NowPlayingQueue + PlaylistItemId so other Jellyfin clients can
        // see Feishin's upcoming tracks (in playback order, respecting shuffle).
        const playerState = usePlayerStoreBase.getState();
        const songsById = playerState.queue.songs;
        const defaultIds = playerState.queue.default;
        const orderedUniqueIds = isShuffleEnabled(playerState)
            ? playerState.queue.shuffled
                  .map((idx) => defaultIds[idx])
                  .filter((id): id is string => Boolean(id))
            : defaultIds;
        const nowPlayingQueue = orderedUniqueIds
            .map((uid) => songsById[uid])
            .filter((s): s is NonNullable<typeof s> => Boolean(s))
            .map((song) => ({ Id: song.id, PlaylistItemId: song._uniqueId }));
        const currentSong = playerState.getCurrentSong();
        const queueFields = {
            IsMuted: playerState.player.muted,
            NowPlayingQueue: nowPlayingQueue,
            PlaylistItemId: currentSong?._uniqueId,
            VolumeLevel: playerState.player.volume,
        };

        // Fire-and-forget scrobble calls intentionally aren't awaited (we
        // don't want them blocking playback), but ts-rest's client returns
        // a promise that rejects on network failure. Without a catch
        // those rejections bubble up as unhandled-rejection events, which
        // the renderer's boot-error overlay (and any production telemetry)
        // treats as crashes. Swallow them — scrobble failures are an
        // expected steady-state condition on flaky networks and aren't
        // actionable in this layer.
        const swallowScrobbleError = (err: unknown) => {
            // Keep a debug-level breadcrumb for anyone with devtools open;
            // upgrade to console.warn would be too loud given how often
            // this fires on cellular.
            if (typeof console !== 'undefined') {
                console.debug('[scrobble] dropped:', err);
            }
        };

        if (query.submission) {
            // Checked by jellyfin-plugin-lastfm for whether or not to send the "finished" scrobble (uses PositionTicks)
            jfApiClient(apiClientProps)
                .scrobbleStopped({
                    body: {
                        IsPaused: true,
                        ItemId: query.id,
                        PositionTicks: position,
                        ...queueFields,
                    },
                })
                .catch(swallowScrobbleError);

            return null;
        }

        if (query.event === 'start') {
            jfApiClient(apiClientProps)
                .scrobblePlaying({
                    body: {
                        ItemId: query.id,
                        PositionTicks: position,
                        ...queueFields,
                    },
                })
                .catch(swallowScrobbleError);

            return null;
        }

        if (query.event === 'pause') {
            jfApiClient(apiClientProps)
                .scrobbleProgress({
                    body: {
                        EventName: query.event,
                        IsPaused: true,
                        ItemId: query.id,
                        PositionTicks: position,
                        ...queueFields,
                    },
                })
                .catch(swallowScrobbleError);

            return null;
        }

        if (query.event === 'unpause') {
            jfApiClient(apiClientProps)
                .scrobbleProgress({
                    body: {
                        EventName: query.event,
                        IsPaused: false,
                        ItemId: query.id,
                        PositionTicks: position,
                        ...queueFields,
                    },
                })
                .catch(swallowScrobbleError);

            return null;
        }

        jfApiClient(apiClientProps)
            .scrobbleProgress({
                body: {
                    ItemId: query.id,
                    PositionTicks: position,
                    ...queueFields,
                },
            })
            .catch(swallowScrobbleError);

        return null;
    },
    search: async (args) => {
        const { apiClientProps, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        let albums: z.infer<typeof jfType._response.albumList>['Items'] = [];
        let albumArtists: z.infer<typeof jfType._response.albumArtistList>['Items'] = [];
        let songs: z.infer<typeof jfType._response.songList>['Items'] = [];

        if (query.albumLimit) {
            const res = await jfApiClient(apiClientProps).getAlbumList({
                params: {
                    userId: apiClientProps.server?.userId,
                },
                query: {
                    EnableTotalRecordCount: true,
                    Fields: JF_FIELDS.ALBUM_LIST,
                    ImageTypeLimit: 1,
                    IncludeItemTypes: 'MusicAlbum',
                    Limit: query.albumLimit,
                    Recursive: true,
                    SearchTerm: query.query,
                    SortBy: 'SortName',
                    SortOrder: 'Ascending',
                    StartIndex: query.albumStartIndex || 0,
                },
            });

            if (res.status !== 200) {
                throw new Error('Failed to get album list');
            }

            albums = res.body.Items;
        }

        if (query.albumArtistLimit) {
            const res = await jfApiClient(apiClientProps).getAlbumArtistList({
                query: {
                    EnableTotalRecordCount: true,
                    Fields: JF_FIELDS.ALBUM_ARTIST_LIST,
                    ImageTypeLimit: 1,
                    IncludeArtists: true,
                    Limit: query.albumArtistLimit,
                    Recursive: true,
                    SearchTerm: query.query,
                    StartIndex: query.albumArtistStartIndex || 0,
                    UserId: apiClientProps.server?.userId,
                },
            });

            if (res.status !== 200) {
                throw new Error('Failed to get album artist list');
            }

            albumArtists = res.body.Items;
        }

        if (query.songLimit) {
            const res = await jfApiClient(apiClientProps).getSongList({
                params: {
                    userId: apiClientProps.server?.userId,
                },
                query: {
                    EnableTotalRecordCount: true,
                    Fields: JF_FIELDS.SONG,
                    IncludeItemTypes: 'Audio',
                    Limit: query.songLimit,
                    Recursive: true,
                    SearchTerm: query.query,
                    SortBy: 'Album,SortName',
                    SortOrder: 'Ascending',
                    StartIndex: query.songStartIndex || 0,
                    UserId: apiClientProps.server?.userId,
                },
            });

            if (res.status !== 200) {
                throw new Error('Failed to get song list');
            }

            songs = res.body.Items;
        }

        return {
            albumArtists: albumArtists.map((item) =>
                jfNormalize.albumArtist(item, apiClientProps.server),
            ),
            albums: albums.map((item) => jfNormalize.album(item, apiClientProps.server)),
            songs: songs.map((item) =>
                jfNormalize.song(
                    item,
                    apiClientProps.server,
                    args.context?.pathReplace,
                    args.context?.pathReplaceWith,
                ),
            ),
        };
    },
    setPlaylistSongs: async (args) => {
        const { apiClientProps, body } = args;

        const res = await jfApiClient(apiClientProps).updatePlaylist({
            body: {
                Ids: body.songIds,
            },
            params: {
                id: body.id,
            },
        });

        if (res.status !== 204) {
            throw new Error('Failed to update playlist songs');
        }

        return null;
    },
    updateInternetRadioStation: async (args) => {
        const { apiClientProps, body, query } = args;

        if (!apiClientProps.serverId) {
            throw new Error('No serverId found');
        }

        const state = useRadioStore.getState();
        if (!state?.actions?.updateStation) {
            throw new Error('Radio store not initialized');
        }

        state.actions.updateStation(apiClientProps.serverId, query.id, {
            homepageUrl: body.homepageUrl || null,
            name: body.name,
            streamUrl: body.streamUrl,
        });

        return null;
    },
    updatePlaylist: async (args) => {
        const { apiClientProps, body, query } = args;

        if (!apiClientProps.server?.userId) {
            throw new Error('No userId found');
        }

        const res = await jfApiClient(apiClientProps).updatePlaylist({
            body: {
                IsPublic: body.public,
                Name: body.name,
            },
            params: {
                id: query.id,
            },
        });

        if (res.status !== 204) {
            throw new Error('Failed to update playlist');
        }

        return null;
    },
};

function getLibraryId(musicFolderId?: string | string[]) {
    return Array.isArray(musicFolderId) ? musicFolderId[0] : musicFolderId;
}
