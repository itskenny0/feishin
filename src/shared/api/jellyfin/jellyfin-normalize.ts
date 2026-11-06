import { z } from 'zod';

import { jfType } from '/@/shared/api/jellyfin/jellyfin-types';
import { coerceYear, parsePartialIsoDateFromApi } from '/@/shared/api/partial-iso-date';
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
import { blurHashesDiffer } from '/@/shared/utils/blurhash';
import { isPlausibleReleaseYear } from '/@/shared/utils/release-year';

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

// Whether a song's own Primary image is provably distinct from its album
// cover. Jellyfin gives almost every track with embedded art its own Primary
// image, usually the album cover again, so keying every song on its own image
// would multiply the thumbnail sweep by the track count. The item carries a
// blurhash for both its own tag and the album's tag; only a real difference
// (or an album with no art at all) counts. A missing blurhash cannot prove
// anything, so the song stays on the album cover.
const songHasOwnCover = (item: z.infer<typeof jfType._response.song>): boolean => {
    const ownTag = item.ImageTags?.Primary;
    if (!ownTag) return false;
    const albumTag = item.AlbumId ? item.AlbumPrimaryImageTag : undefined;
    if (!albumTag) return true;
    const hashes = item.ImageBlurHashes?.Primary;
    return blurHashesDiffer(hashes?.[ownTag], hashes?.[albumTag]);
};

const getSongImageId = (
    item: z.infer<typeof jfType._response.song>,
    hasOwnCover: boolean,
): null | string => {
    if (hasOwnCover) return item.Id;
    if (item.AlbumPrimaryImageTag && item.AlbumId) return item.AlbumId;
    return null;
};

const getPrimaryImageId = (item: { Id: string; ImageTags?: { Primary?: string } }) =>
    item.ImageTags?.Primary ? item.Id : null;

const toRelatedArtist = (
    entry: { Id: string; Name: string },
    imageId: null | string,
): RelatedArtist => ({
    id: entry.Id,
    imageId,
    imageUrl: null,
    name: entry.Name,
    userFavorite: false,
    userRating: null,
});

// GenreItems is typed as required but can be missing at runtime (responses are
// not validated), so each caller keeps its own fallback.
const toGenres = (items: { Id: string; Name: string }[], server: null | ServerListItem): Genre[] =>
    items?.map((entry) => ({
        _itemType: LibraryItem.GENRE,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        albumCount: null,
        id: entry.Id,
        imageId: null,
        imageUrl: null,
        name: entry.Name,
        songCount: null,
    }));

const getBlurHash = (
    item:
        | z.infer<typeof jfType._response.album>
        | z.infer<typeof jfType._response.albumArtist>
        | z.infer<typeof jfType._response.playlist>
        | z.infer<typeof jfType._response.song>,
): null | string => {
    return item.ImageBlurHashes?.Primary?.[item.ImageTags?.Primary ?? ''] || null;
};

const jellyfinPremiereFields = (item: {
    PremiereDate?: string;
    ProductionYear?: number;
}): { releaseDate: null | string; releaseYear: null | number } => {
    // Jellyfin sends .NET DateTime.MinValue ("0001-01-01T00:00:00") for an
    // unknown date, which would otherwise surface as the year 1.
    const premiere = parsePartialIsoDateFromApi(item.PremiereDate ?? null);
    const premiereValid = isPlausibleReleaseYear(premiere.year);
    const prodYear = coerceYear(item.ProductionYear);
    const fallbackYear = isPlausibleReleaseYear(prodYear) ? prodYear : null;
    const releaseYear: null | number = premiereValid ? premiere.year : fallbackYear;
    const releaseDate =
        (premiereValid ? premiere.date : null) ??
        (fallbackYear !== null ? String(fallbackYear) : null);
    return { releaseDate, releaseYear };
};

const normalizeSong = (
    item: z.infer<typeof jfType._response.song>,
    server: null | ServerListItem,
): Song => {
    let bitDepth: null | number = null;
    let bitRate = 0;
    let channels: null | number = null;
    let codec: null | string = null;
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
                    codec = stream.Codec || null;
                    sampleRate = stream.SampleRate || null;
                    break;
                }
            }
        }
    } else {
        warnNoMediaSourceOnce(item as { Id?: string });
    }

    const { releaseDate, releaseYear } = jellyfinPremiereFields(item);
    const hasOwnCover = songHasOwnCover(item);

    return {
        _itemType: LibraryItem.SONG,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        album: item.Album,
        albumArtistName: item.AlbumArtist || '',
        albumArtists: item.AlbumArtists?.map((entry) => toRelatedArtist(entry, entry.Id)),
        albumId: item.AlbumId || `dummy/${item.Id}`,
        artistName: item?.ArtistItems?.map((entry) => entry.Name).join(', ') || '',
        artists: (item?.ArtistItems?.length ? item.ArtistItems : item.AlbumArtists)?.map((entry) =>
            toRelatedArtist(entry, null),
        ),
        bitDepth,
        bitRate,
        blurHash: getBlurHash(item),
        bpm: null,
        channels,
        codec,
        comment: null,
        compilation: null,
        container,
        createdAt: item.DateCreated,
        date: releaseDate,
        discNumber: item.ParentIndexNumber ?? 1,
        discSubtitle: null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        explicitStatus: null,
        folderId: null,
        gain:
            item.AlbumNormalizationGain !== undefined ||
            item.NormalizationGain !== undefined ||
            item.LUFS !== undefined
                ? {
                      album: item.AlbumNormalizationGain,
                      track:
                          item.NormalizationGain !== undefined
                              ? item.NormalizationGain
                              : item.LUFS !== undefined
                                ? -18 - item.LUFS
                                : undefined,
                  }
                : null,
        genres: toGenres(item.GenreItems, server) || null,
        hasOwnCover,
        id: item.Id,
        imageId: getSongImageId(item, hasOwnCover),
        imageUrl: null,
        isResumable: item.Type === 'AudioBook',
        lastPlayedAt: null,
        libraryId: null,
        libraryName: null,
        lyrics: null,
        mbzAlbumId: item.ProviderIds?.MusicBrainzAlbum || null,
        mbzAlbumType: null,
        mbzRecordingId: item.ProviderIds?.MusicBrainzRecording || null,
        mbzReleaseGroupId: null,
        mbzTrackId: item.ProviderIds?.MusicBrainzTrack || null,
        missing: null,
        name: item.Name,
        originalDate: releaseDate,
        originalYear: releaseYear,
        participants: null,
        path: path || '',
        peak: null,
        playCount: (item.UserData && item.UserData.PlayCount) || 0,
        playlistItemId: item.PlaylistItemId,
        releaseDate,
        releaseYear,
        resumePositionMs: item.UserData
            ? item.UserData.PlaybackPositionTicks / TICKS_PER_MS
            : undefined,
        sampleRate,
        size,
        sortName: item.SortName || item.Name,
        tags: getTags(item),
        thumbHash: null,
        trackNumber: item.IndexNumber,
        trackSubtitle: null,
        updatedAt: item.DateCreated,
        userFavorite: (item.UserData && item.UserData.IsFavorite) || false,
        userRating: null,
        year: releaseYear,
    };
};

const normalizeAlbum = (
    item: z.infer<typeof jfType._response.album>,
    server: null | ServerListItem,
): Album => {
    const { releaseDate, releaseYear } = jellyfinPremiereFields(item);

    return {
        _itemType: LibraryItem.ALBUM,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        albumArtistName: item.AlbumArtist,
        albumArtists: item.AlbumArtists.map((entry) => toRelatedArtist(entry, entry.Id)),
        artists: (item.ArtistItems?.length ? item.ArtistItems : item.AlbumArtists)?.map((entry) =>
            toRelatedArtist(entry, entry.Id),
        ),
        blurHash: getBlurHash(item),
        comment: null,
        createdAt: item.DateCreated,
        discs: null,
        dominantColor: null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        explicitStatus: null,
        gain: null,
        genres: toGenres(item.GenreItems, server) || [],
        id: item.Id,
        imageId: getPrimaryImageId(item),
        imageUrl: null,
        isCompilation: null,
        lastPlayedAt: null,
        mbzId: item.ProviderIds?.MusicBrainzAlbum || null,
        mbzReleaseGroupId: item.ProviderIds?.MusicBrainzReleaseGroup || null,
        missing: null,
        name: item.Name,
        originalDate: releaseDate,
        originalYear: releaseYear,
        participants: null,
        path: item.Path || null,
        peak: null,
        playCount: item.UserData?.PlayCount || 0,
        ratedAt: null,
        recordLabels: item.Studios?.map((entry) => entry.Name) || [],
        releaseDate,
        releaseType: null,
        releaseTypes: [],
        releaseYear,
        size: null,
        songCount: item?.ChildCount ?? null,
        songs: item.Songs?.map((song) => normalizeSong(song, server)),
        sortName: item.SortName || item.Name,
        starredAt: null,
        tags: getTags(item),
        thumbHash: null,
        trackYearRange: null,
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
                imageId: getPrimaryImageId(entry),
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
        blurHash: getBlurHash(item),
        createdAt: item.DateCreated ?? null,
        dominantColor: null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        genres: toGenres(item.GenreItems, server),
        id: item.Id,
        imageId: getPrimaryImageId(item),
        imageUrl: null,
        lastPlayedAt: null,
        mbz: item.ProviderIds?.MusicBrainzArtist || null,
        missing: null,
        name: item.Name,
        playCount: item.UserData?.PlayCount || 0,
        ratedAt: null,
        similarArtists,
        songCount: item.SongCount ?? null,
        starredAt: null,
        thumbHash: null,
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
        blurHash: getBlurHash(item),
        description: item.Overview || null,
        dominantColor: null,
        duration: item.RunTimeTicks / TICKS_PER_MS,
        evaluatedAt: null,
        genres: toGenres(item.GenreItems, server),
        id: item.Id,
        imageId: getPrimaryImageId(item),
        imageUrl: null,
        name: item.Name,
        owner: null,
        ownerId: null,
        public: null,
        rules: null,
        size: null,
        songCount: item?.ChildCount ?? null,
        sync: null,
        thumbHash: null,
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

const normalizeGenre = (
    item: z.infer<typeof jfType._response.genre>,
    server: null | ServerListItem,
): Genre => {
    return {
        _itemType: LibraryItem.GENRE,
        _serverId: server?.id || '',
        _serverType: ServerType.JELLYFIN,
        albumCount: item.AlbumCount ?? null,
        id: item.Id,
        imageId: getPrimaryImageId(item),
        imageUrl: null,
        name: item.Name,
        songCount: item.SongCount ?? null,
    };
};

const normalizeFolder = (
    item: z.infer<typeof jfType._response.folder>,
    server: null | ServerListItem,
): Folder => {
    return {
        _itemType: LibraryItem.FOLDER,
        _serverId: server?.id || 'unknown',
        _serverType: ServerType.JELLYFIN,
        children: undefined,
        id: item.Id,
        name: item.Name || 'Unknown folder',
        parentId: item.ParentId,
        path: item.Path || null,
    };
};

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
