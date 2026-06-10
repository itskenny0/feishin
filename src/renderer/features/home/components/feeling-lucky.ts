import type { LibraryCacheDb } from '/@/renderer/cache/db';

import { shuffle } from '/@/renderer/utils/shuffle';
import { Song } from '/@/shared/types/domain-types';

/** Total tracks a local "feeling lucky" pick puts in the queue (matches the
 *  remote path's 20 + 80). */
export const LUCKY_QUEUE_SIZE = 100;

/**
 * Pick up to `size` random songs from the local cache. Reads primary keys
 * only (cheap even for a large library), shuffles, then hydrates just the
 * chosen rows so we never load every payload into memory. Returns the
 * normalized Song payloads.
 */
export const pickRandomFromCache = async (db: LibraryCacheDb, size: number): Promise<Song[]> => {
    const ids = (await db.songs.toCollection().primaryKeys()) as string[];
    if (ids.length === 0) return [];
    const pickedIds = shuffle(ids).slice(0, size);
    const rows = await db.songs.bulkGet(pickedIds);
    return rows.filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => r.Payload);
};

/**
 * Derive the song ids that are downloaded offline for `serverId` from the
 * in-memory offline-availability snapshot. The snapshot holds
 * `${serverId}:${songId}` blob keys; we strip the server prefix and keep only
 * this server's songs. Pure (no Dexie) — the snapshot is already in memory.
 */
export const offlineSongIdsForServer = (
    songKeys: ReadonlySet<string>,
    serverId: string,
): string[] => {
    const prefix = `${serverId}:`;
    const out: string[] = [];
    for (const key of songKeys) {
        if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    }
    return out;
};

/**
 * Pick up to `size` random songs limited to the OFFLINE-AVAILABLE pool
 * (downloaded blobs for this server). `offlineSongIds` is the result of
 * {@link offlineSongIdsForServer}. Shuffles the offline ids, then hydrates only
 * the chosen rows from the library cache so we never load every payload. Rows
 * that exist as a downloaded blob but whose metadata isn't in the library cache
 * are skipped. Returns the normalized Song payloads.
 */
export const pickRandomOfflineFromCache = async (
    db: LibraryCacheDb,
    offlineSongIds: readonly string[],
    size: number,
): Promise<Song[]> => {
    if (offlineSongIds.length === 0) return [];
    const pickedIds = shuffle([...offlineSongIds]).slice(0, size);
    const rows = await db.songs.bulkGet(pickedIds);
    return rows.filter((r): r is NonNullable<typeof r> => Boolean(r)).map((r) => r.Payload);
};
