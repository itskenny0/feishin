// Persist a downloaded song's metadata into db.songs so the "Available offline"
// view can render it without relying on the library sweep having cached it.
// db.songs carries no audio blobs, so these reads/writes are cheap. Upsert-
// missing only, to avoid churning sweep-written rows.

import type { Song } from '/@/shared/types/domain-types';

import type { LibraryCacheDb } from '../db';

import { getActiveCacheDb } from '../db';
import { toCachedSongRow } from '../row-mappers';

const TAG = '[offline-media]';

export const cacheOfflineSongMeta = async (
    songs: Song[],
    db: LibraryCacheDb | undefined = getActiveCacheDb(),
): Promise<void> => {
    if (!db || songs.length === 0) return;
    try {
        const ids = songs.map((s) => s.id);
        const existing = await db.songs.bulkGet(ids);
        const missing: Song[] = [];
        for (let i = 0; i < songs.length; i += 1) {
            if (!existing[i]) missing.push(songs[i]);
        }
        if (missing.length) {
            await db.songs.bulkPut(missing.map(toCachedSongRow));
            console.info(`${TAG} cached offline song meta`, { added: missing.length });
        }
    } catch (err) {
        console.warn(`${TAG} cacheOfflineSongMeta failed`, err);
    }
};
