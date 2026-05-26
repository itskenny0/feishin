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
