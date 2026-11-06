// The image-cache key for a song-like item's cover (SONG / QUEUE_SONG /
// PLAYLIST_SONG). Covers render from the local cache only, and the thumbnail
// sweep caches album covers keyed by album id plus the own cover of songs whose
// art is distinct from their album (`hasOwnCover`, set by the normalizer). Every
// song cover surface must key through here so they all agree with the sweep.
// A song without distinct art shares its album's cover (`albumId ?? imageId`).
export interface SongCoverSource {
    albumId?: null | string;
    hasOwnCover?: boolean;
    imageId?: null | string;
}

export const songCoverId = (song: null | SongCoverSource | undefined): string | undefined => {
    if (!song) return undefined;
    if (song.hasOwnCover && song.imageId) return song.imageId;
    return song.albumId ?? song.imageId ?? undefined;
};
