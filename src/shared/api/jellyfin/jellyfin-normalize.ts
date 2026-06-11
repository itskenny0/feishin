import { z } from 'zod';

import { jfType } from '/@/shared/api/jellyfin/jellyfin-types';
import { coerceYear, parsePartialIsoDateFromApi } from '/@/shared/api/partial-iso-date';
import { replacePathPrefix } from '/@/shared/api/utils';
import {
    Album,
    AlbumArtist,
    Folder,
    Genre,
    LibraryItem,
    MusicFolder,
    Playlist,
    RelatedArtist,
    Song,
} from '/@/shared/types/domain-types';
import { ServerListItem, ServerType } from '/@/shared/types/types';

const TICKS_PER_MS = 10000;

// A `/Sessions` payload's embedded NowPlayingItem never carries `MediaSources`,
// so a remote-target controller that re-normalizes the mirrored track on every
// 2Hz session frame used to log "no media sources" once PER FRAME, with the
// full item object. With remote-debug shipping on, each such line is
// JSON-stringified and written through to a localStorage ring on the main
// thread, so the warn itself became sustained per-frame pressure. Rate-limit it
// to once per item id (bounded set, oldest-evicted) so the SAME track warns at
// most once no matter how many frames re-normalize it.
const NO_MEDIA_SOURCE_WARN_CAP = 200;
const warnedNoMediaSourceIds = new Set<string>();
const warnNoMediaSourceOnce = (item: { Id?: string }): void => {
    const id = typeof item?.Id === 'string' ? item.Id : '';
    if (id && warnedNoMediaSourceIds.has(id)) return;
    if (id) {
        warnedNoMediaSourceIds.add(id);
        if (warnedNoMediaSourceIds.size > NO_MEDIA_SOURCE_WARN_CAP) {
            const oldest = warnedNoMediaSourceIds.values().next().value;
            if (oldest !== undefined) warnedNoMediaSourceIds.delete(oldest);
        }
    }
    console.warn('Jellyfin song retrieved with no media sources', item);
};

type AlbumOrSong = z.infer<typeof jfType._response.album> | z.infer<typeof jfType._response.song>;

const KEYS_TO_OMIT = new Set(['AlbumArtist', 'Artist']);

const getPeople = (item: AlbumOrSong): null | Record<string, RelatedArtist[]> => {
    if (item.People) {
        const participants: Record<string, RelatedArtist[]> = {};

        for (const person of item.People) {
            const key = person.Type || '';
            if (KEYS_TO_OMIT.has(key)) {
                continue;
            }

            const item: RelatedArtist = {
                // for other roles, we just want to display this and not filter.
                // filtering (and links) would require a separate field, PersonIds
                id: '',
                imageId: null,
                imageUrl: null,
                name: person.Name,
                userFavorite: false,
                userRating: null,
            };

            if (key in participants) {
                participants[key].push(item);
            } else {
                participants[key] = [item];
            }
        }

        return participants;
    }

    return null;
};

const getTags = (item: AlbumOrSong): null | Record<string, string[]> => {
    if (item.Tags) {
        const tags: Record<string, string[]> = {};
        for (const tag of item.Tags) {
            tags[tag] = [];
        }

        return tags;
    }

    return null;
};

const getSongImageId = (item: z.infer<typeof jfType._response.song>): null | string => {
    if (item.ImageTags?.Primary) {
        return item.Id;
    }

    if (item.AlbumPrimaryImageTag && item.AlbumId) {
        return item.AlbumId;
    }

    return null;
};

const getAlbumImageId = (item: z.infer<typeof jfType._response.album>): null | string => {
    if (item.ImageTags?.Primary) {
        return item.Id;
    }

    return null;
};

const getAlbumArtistImageId = (
    item: z.infer<typeof jfType._response.albumArtist>,
): null | string => {
    if (item.ImageTags?.Primary) {
        return item.Id;
    }

    return null;
};

const getPlaylistImageId = (item: z.infer<typeof jfType._response.playlist>): null | string => {
    if (item.ImageTags?.Primary) {
        return item.Id;
    }

    return null;
};

const getArtists = (
    item: z.infer<typeof jfType._response.song>,
    participants?: null | Record<string, RelatedArtist[]>,
): RelatedArtist[] => {
    if (!item?.ArtistItems?.length && !item.AlbumArtists && !participants) {
        return [];
    }

    const result: RelatedArtist[] = [];

    (item?.ArtistItems?.length ? item.ArtistItems : item.AlbumArtists)?.forEach((entry) => {
        result.push({
            id: entry.Id,
            imageId: null,
            imageUrl: null,
            name: entry.Name,
            userFavorite: false,
            userRating: null,
        });
    });

    if (participants?.['Remixer']) {
        const existingIds = new Set(result.map((artist) => artist.id));
        for (const participant of participants['Remixer']) {
            if (!existingIds.has(participant.id)) {
                result.push(participant);
            }
        }
    }

    return result;
};

const jellyfinPremiereFields = (item: {
    PremiereDate?: string;
    ProductionYear?: number;
}): { originalYear: number; releaseDate: null | string; releaseYear: null | number } => {
    const premiere = parsePartialIsoDateFromApi(item.PremiereDate ?? null);
    const prodYear = coerceYear(item.ProductionYear);
    const releaseYear: null | number =
        premiere.year > 0 ? premiere.year : prodYear > 0 ? prodYear : null;
    const releaseDate = premiere.date ?? (prodYear > 0 ? String(prodYear) : null);
    const originalYear = premiere.year > 0 ? premiere.year : prodYear;
    return { originalYear, releaseDate, releaseYear };
};

const normalizeSong = (
    item: z.infer<typeof jfType._response.song>,
    server: null | ServerListItem,
    pathReplace?: string,
    pathReplaceWith?: string,
): Song => {
    let bitDepth: null | number = null;
    let bitRate = 0;
    let channels: null | number = null;
    let container: null | string = null;
    let path: null | string = null;
    let sampleRate: null | number = null;
    let size = 0;

    if (item.MediaSources?.length) {
        const source = item.MediaSources[0];

        container = source.Container;
        path = source.Path;
        size = source.Size;

        if ((source.MediaStreams?.length || 0) > 0) {
            for (const stream of source.MediaStreams) {
                if (stream.Type === 'Audio') {
                    bitDepth = stream.BitDepth || null;
                    bitRate =
                        stream.BitRate !== undefined
                            ? Number(Math.trunc(stream.BitRate / 1000))
                            : 0;
                    channels = stream.Channels || null;
                    sampleRate = stream.SampleRate || null;
                    break;
                }
            }
        }
    } else {
        warnNoMediaSourceOnce(item as { Id?: string });
    }

    const participants = getPeople(item);

    const artists = getArtists(item, participants);

    const { releaseDate, releaseYear } = jellyfinPremiereFields(item);

    return {
        _itemType: LibraryItem.SONG,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        album: item.Album,
        albumArtistName: item.AlbumArtist || '',
        albumArtists: item.AlbumArtists?.map((entry) => ({
            id: entry.Id,
            imageId: entry.Id,
            imageUrl: null,
            name: entry.Name,
            userFavorite: false,
            userRating: null,
        })),
        albumId: item.AlbumId || `dummy/${item.Id}`,
        artistName: item?.ArtistItems?.map((entry) => entry.Name).join(', ') || '',
        artists,
        bitDepth,
        bitRate,
        bpm: null,
        channels,
        comment: null,
        compilation: null,
        container,
        createdAt: item.DateCreated,
        discNumber: item.ParentIndexNumber ?? 1,
        discSubtitle: null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        explicitStatus: null,
        gain:
            item.NormalizationGain !== undefined
                ? {
                      track: item.NormalizationGain,
                  }
                : item.LUFS
                  ? {
                        track: -18 - item.LUFS,
                    }
                  : null,
        genres: item.GenreItems?.map((entry) => ({
            _itemType: LibraryItem.GENRE,
            _serverId: server?.id || '',
            _serverType: ServerType.JELLYFIN,
            albumCount: null,
            id: entry.Id,
            imageId: null,
            imageUrl: null,
            name: entry.Name,
            songCount: null,
        })),
        id: item.Id,
        imageId: getSongImageId(item),
        imageUrl: null,
        lastPlayedAt: null,
        lyrics: null,
        mbzRecordingId: item.ProviderIds?.MusicBrainzRecording || null,
        mbzTrackId: item.ProviderIds?.MusicBrainzTrack || null,
        name: item.Name,
        participants,
        path: replacePathPrefix(path || '', pathReplace, pathReplaceWith),
        peak: null,
        playCount: (item.UserData && item.UserData.PlayCount) || 0,
        playlistItemId: item.PlaylistItemId,
        releaseDate,
        releaseYear,
        sampleRate,
        size,
        sortName: item.SortName || item.Name,
        tags: getTags(item),
        trackNumber: item.IndexNumber,
        trackSubtitle: null,
        updatedAt: item.DateCreated,
        userFavorite: (item.UserData && item.UserData.IsFavorite) || false,
        userRating: null,
    };
};

const normalizeAlbum = (
    item: z.infer<typeof jfType._response.album>,
    server: null | ServerListItem,
    pathReplace?: string,
    pathReplaceWith?: string,
): Album => {
    const { originalYear, releaseDate, releaseYear } = jellyfinPremiereFields(item);

    return {
        _itemType: LibraryItem.ALBUM,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        albumArtistName: item.AlbumArtist,
        albumArtists:
            item.AlbumArtists.map((entry) => ({
                id: entry.Id,
                imageId: entry.Id,
                imageUrl: null,
                name: entry.Name,
                userFavorite: false,
                userRating: null,
            })) || [],
        artists: (item.ArtistItems?.length ? item.ArtistItems : item.AlbumArtists)?.map(
            (entry) => ({
                id: entry.Id,
                imageId: entry.Id,
                imageUrl: null,
                name: entry.Name,
                userFavorite: false,
                userRating: null,
            }),
        ),
        comment: null,
        createdAt: item.DateCreated,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        explicitStatus: null,
        genres:
            item.GenreItems?.map((entry) => ({
                _itemType: LibraryItem.GENRE,
                _serverId: server?.id || '',
                _serverType: ServerType.JELLYFIN,
                albumCount: null,
                id: entry.Id,
                imageId: null,
                imageUrl: null,
                name: entry.Name,
                songCount: null,
            })) || [],
        id: item.Id,
        imageId: getAlbumImageId(item),
        imageUrl: null,
        isCompilation: null,
        lastPlayedAt: null,
        mbzId: item.ProviderIds?.MusicBrainzAlbum || null,
        mbzReleaseGroupId: item.ProviderIds?.MusicBrainzReleaseGroup || null,
        name: item.Name,
        originalDate: releaseDate,
        originalYear,
        participants: getPeople(item),
        path: item.Path ? replacePathPrefix(item.Path, pathReplace, pathReplaceWith) : null,
        playCount: item.UserData?.PlayCount || 0,
        recordLabels: item.Studios?.map((entry) => entry.Name) || [],
        releaseDate,
        releaseType: null,
        releaseTypes: [],
        releaseYear,
        size: null,
        songCount: item?.ChildCount || null,
        songs: item.Songs?.map((song) => normalizeSong(song, server, pathReplace, pathReplaceWith)),
        sortName: item.SortName || item.Name,
        tags: getTags(item),
        updatedAt: item?.DateLastMediaAdded || item.DateCreated,
        userFavorite: item.UserData?.IsFavorite || false,
        userRating: null,
        version: null,
    };
};

const normalizeAlbumArtist = (
    item: z.infer<typeof jfType._response.albumArtist> & {
        similarArtists?: z.infer<typeof jfType._response.albumArtistList>;
    },
    server: null | ServerListItem,
): AlbumArtist => {
    const similarArtists =
        item.similarArtists?.Items?.filter((entry) => entry.Name !== 'Various Artists').map(
            (entry) => ({
                id: entry.Id,
                imageId: getAlbumArtistImageId(entry),
                imageUrl: null,
                name: entry.Name,
                userFavorite: entry.UserData?.IsFavorite || false,
                userRating: null,
            }),
        ) || [];

    return {
        _itemType: LibraryItem.ALBUM_ARTIST,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        albumCount: item.AlbumCount ?? null,
        biography: item.Overview || null,
        createdAt: item.DateCreated ?? null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        genres: item.GenreItems?.map((entry) => ({
            _itemType: LibraryItem.GENRE,
            _serverId: server?.id || '',
            _serverType: ServerType.JELLYFIN,
            albumCount: null,
            id: entry.Id,
            imageId: null,
            imageUrl: null,
            name: entry.Name,
            songCount: null,
        })),
        id: item.Id,
        imageId: getAlbumArtistImageId(item),
        imageUrl: null,
        lastPlayedAt: null,
        mbz: item.ProviderIds?.MusicBrainzArtist || null,
        name: item.Name,
        playCount: item.UserData?.PlayCount || 0,
        similarArtists,
        songCount: item.SongCount ?? null,
        uploadedImage: item.ImageTags?.Primary ?? undefined,
        userFavorite: item.UserData?.IsFavorite || false,
        userRating: null,
    };
};

const normalizePlaylist = (
    item: z.infer<typeof jfType._response.playlist>,
    server: null | ServerListItem,
): Playlist => {
    return {
        _itemType: LibraryItem.PLAYLIST,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        description: item.Overview || null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        genres: item.GenreItems?.map((entry) => ({
            _itemType: LibraryItem.GENRE,
            _serverId: server?.id || '',
            _serverType: ServerType.JELLYFIN,
            albumCount: null,
            id: entry.Id,
            imageId: null,
            imageUrl: null,
            name: entry.Name,
            songCount: null,
        })),
        id: item.Id,
        imageId: getPlaylistImageId(item),
        imageUrl: null,
        name: item.Name,
        owner: null,
        ownerId: null,
        public: null,
        rules: null,
        size: null,
        songCount: item?.ChildCount || null,
        sync: null,
        uploadedImage: item.ImageTags?.Primary ?? undefined,
    };
};

/**
 * Whether a Jellyfin playlist is an audio playlist Feishin can present.
 *
 * Jellyfin has no first-class "smart playlist" type, but it DOES return
 * non-audio playlists (video/photo/mixed containers) from the same
 * `getPlaylistList` endpoint. Feishin is an audio client, so those are dropped
 * client-side (they used to be excluded via a `MediaTypes:Audio` request param,
 * but that made the server report a non-zero TotalRecordCount with an empty
 * Items array — see the getPlaylistList controller comment). A playlist counts
 * as audio when its `MediaType` is "Audio"; Jellyfin reports the dominant media
 * type of the container's contents here.
 */
export const isAudioPlaylist = (item: z.infer<typeof jfType._response.playlist>): boolean =>
    item.MediaType === 'Audio';

/**
 * Normalize a page of the Jellyfin playlist-list response, dropping non-audio
 * playlists AND keeping `totalRecordCount` consistent with what's actually
 * returned.
 *
 * Residual imperfection: Jellyfin's `TotalRecordCount` counts ALL playlists
 * across the whole result set, but we can only see (and therefore subtract) the
 * non-audio ones present in THIS page. So the corrected total is exact for a
 * single-page (unpaginated) fetch — which is how the playlist list is loaded —
 * but for a paginated fetch it only removes the dropped count of the current
 * page, not non-audio playlists living on other pages. This is still strictly
 * better than the old behavior (header overcount + trailing skeleton rows that
 * never fill) and avoids a second full-scan request just to count.
 */
export const normalizePlaylistList = (
    body: z.infer<typeof jfType._response.playlistList>,
    server: null | ServerListItem,
): { items: Playlist[]; totalRecordCount: number } => {
    const audioItems = body.Items.filter(isAudioPlaylist);
    const droppedInPage = body.Items.length - audioItems.length;
    const totalRecordCount = Math.max(0, (body.TotalRecordCount ?? 0) - droppedInPage);
    return {
        items: audioItems.map((item) => normalizePlaylist(item, server)),
        totalRecordCount,
    };
};

const normalizeMusicFolder = (item: z.infer<typeof jfType._response.musicFolder>): MusicFolder => {
    return {
        id: item.Id,
        name: item.Name,
    };
};

// const normalizeArtist = (item: any) => {
//   return {
//     album: (item.album || []).map((entry: any) => normalizeAlbum(entry)),
//     albumCount: item.AlbumCount,
//     duration: item.RunTimeTicks / 10000000,
//     genre: item.GenreItems && item.GenreItems.map((entry: any) => normalizeItem(entry)),
//     id: item.Id,
//     image: getCoverArtUrl(item),
//     info: {
//       biography: item.Overview,
//       externalUrl: (item.ExternalUrls || []).map((entry: any) => normalizeItem(entry)),
//       imageUrl: undefined,
//       similarArtist: (item.similarArtist || []).map((entry: any) => normalizeArtist(entry)),
//     },
//     starred: item.UserData && item.UserData?.IsFavorite ? 'true' : undefined,
//     title: item.Name,
//     uniqueId: nanoid(),
//   };
// };

const getGenreImageId = (item: z.infer<typeof jfType._response.genre>): null | string => {
    if (item.ImageTags?.Primary) {
        return item.Id;
    }

    return null;
};

const normalizeGenre = (
    item: z.infer<typeof jfType._response.genre>,
    server: null | ServerListItem,
): Genre => {
    return {
        _itemType: LibraryItem.GENRE,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        albumCount: null,
        id: item.Id,
        imageId: getGenreImageId(item),
        imageUrl: null,
        name: item.Name,
        songCount: null,
    };
};

const normalizeFolder = (
    item: z.infer<typeof jfType._response.folder>,
    server: null | ServerListItem,
    pathReplace?: string,
    pathReplaceWith?: string,
): Folder => {
    // Read raw Path off the JSON object regardless of zod-inferred type, in
    // case the schema-derived type strips or narrows the field.
    const rawPath = (item as { Path?: null | string }).Path;
    const path = rawPath ? replacePathPrefix(rawPath, pathReplace, pathReplaceWith) : null;
    return {
        _itemType: LibraryItem.FOLDER,
        _serverId: server?.id || 'unknown',
        _serverType: ServerType.JELLYFIN,
        children: undefined,
        id: item.Id,
        name: item.Name || 'Unknown folder',
        parentId: item.ParentId,
        path,
    };
};

// const normalizeScanStatus = () => {
//   return {
//     count: 'N/a',
//     scanning: false,
//   };
// };

export const jfNormalize = {
    album: normalizeAlbum,
    albumArtist: normalizeAlbumArtist,
    folder: normalizeFolder,
    genre: normalizeGenre,
    musicFolder: normalizeMusicFolder,
    playlist: normalizePlaylist,
    playlistList: normalizePlaylistList,
    song: normalizeSong,
};
