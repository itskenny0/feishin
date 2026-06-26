// Local (Dexie) fallback for play-by-fetch song resolution.
//
// "Play" on an album / artist / playlist resolves the songs via the server
// (fetchSongsByItemType in player-context). When the server is unreachable —
// the headline case being a fully-downloaded "available offline" item played
// while actually offline — the enqueue used to fail outright. This resolver
// answers the same (itemType, ids) contract from the cache tables so cached
// items can still play; the audio engine then serves the downloaded blobs.
//
// Returns `undefined` when the cache can't answer (no rows, unsupported item
// type, cache disabled) — callers keep their original network error in that
// case rather than surfacing an empty queue.

import type { Song } from '/@/shared/types/domain-types';

import { getActiveCacheDb } from './db';

import { LibraryItem } from '/@/shared/types/domain-types';

const byAlbumOrder = (a: Song, b: Song): number => {
    const disc = (a.discNumber ?? 0) - (b.discNumber ?? 0);
    if (disc !== 0) return disc;
    const track = (a.trackNumber ?? 0) - (b.trackNumber ?? 0);
    if (track !== 0) return track;
    return (a.name ?? '').localeCompare(b.name ?? '');
};

/**
 * Resolve a cached song's ALBUM id. A song's cover lives on its album — the
 * thumbnail sweep caches album/artist covers, never per-song — so any surface
 * that wants a song's artwork must key on the album id, not the song id.
 * Returns null when the song isn't cached or the cache is unavailable.
 */
export const getCachedSongAlbumId = async (songId: string): Promise<null | string> => {
    const db = getActiveCacheDb();
    if (!db) return null;
    try {
        const row = await db.songs.get(songId);
        return row?.AlbumId ?? row?.Payload?.albumId ?? null;
    } catch {
        return null;
    }
};

export const resolveSongsByItemTypeLocal = async (args: {
    id: string[];
    itemType: LibraryItem;
}): Promise<Song[] | undefined> => {
    const db = getActiveCacheDb();
    if (!db || args.id.length === 0) return undefined;

    try {
        switch (args.itemType) {
            case LibraryItem.ALBUM: {
                const rows = await db.songs.where('AlbumId').anyOf(args.id).toArray();
                if (rows.length === 0) return undefined;
                const songs = rows
                    .map((r) => r.Payload as Song)
                    .filter(Boolean)
                    .sort(byAlbumOrder);
                return songs.length > 0 ? songs : undefined;
            }
            case LibraryItem.ALBUM_ARTIST:
            case LibraryItem.ARTIST: {
                const rows = await db.songs.where('AlbumArtistId').anyOf(args.id).toArray();
                if (rows.length === 0) return undefined;
                const songs = rows
                    .map((r) => r.Payload as Song)
                    .filter(Boolean)
                    .sort(byAlbumOrder);
                return songs.length > 0 ? songs : undefined;
            }
            case LibraryItem.PLAYLIST: {
                const rows = await db.playlistSongs
                    .where('PlaylistId')
                    .anyOf(args.id)
                    .sortBy('ListOrder');
                if (rows.length === 0) return undefined;
                const songs = rows.map((r) => r.SongPayload).filter(Boolean);
                return songs.length > 0 ? songs : undefined;
            }
            // Plain song ids (pinned songs on the homepage, play-by-id).
            // Preserve the caller's order — there is no natural sort for an
            // explicit id list.
            case LibraryItem.SONG: {
                const rows = await db.songs.where('Id').anyOf(args.id).toArray();
                if (rows.length === 0) return undefined;
                const byId = new Map(rows.map((r) => [r.Id as string, r.Payload as Song]));
                const songs = args.id
                    .map((id) => byId.get(id))
                    .filter((s): s is Song => Boolean(s));
                return songs.length > 0 ? songs : undefined;
            }
            default:
                // Genres / folders have no usable local index — let the
                // caller surface its network error.
                return undefined;
        }
    } catch (err) {
        console.warn('[cache] local songs-by-item resolve failed', {
            error: (err as Error)?.message,
            itemType: args.itemType,
        });
        return undefined;
    }
};
