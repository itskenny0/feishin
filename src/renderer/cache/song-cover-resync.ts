// One-shot song re-sync for track cover identity.
//
// Songs cached before tracks got their own cover identity were normalized
// album-first: no `hasOwnCover`, `imageId` = the album, and no `OwnCoverId`
// index entry. The song sweep only runs a newest-first delta once a sync is
// `full`, so those rows would never be rewritten and a synced library would
// never show per-track art. Like the thumbnail miss-purge, this is a
// syncMeta-flagged one-shot (never a Dexie upgrade, which blocks DB-open): it
// rewinds the songs sweep to a full name-ordered pass from index 0 that
// re-normalizes every row, after which the thumbnail sweep at the end of the
// same hydration caches the distinct covers. The sweep's own page checkpoints
// resume the pass across launches.

import type { ServerListItem } from '/@/shared/types/domain-types';

import type { LibraryCacheDb } from './db';
import type { EntityType } from './types';

import { useCacheStore } from './store';
import { hydrate } from './sync';

import { useSettingsStore } from '/@/renderer/store';

export const SONG_COVER_RESYNC_FLAG = 'songCoverIdentity_v1';

const TAG = '[cache] song cover identity';

export const scheduleSongCoverResyncOnce = async (
    db: LibraryCacheDb,
    server: ServerListItem,
): Promise<void> => {
    try {
        if (await db.syncMeta.get(SONG_COVER_RESYNC_FLAG as EntityType)) return;
        const [songs, meta] = await Promise.all([db.songs.count(), db.syncMeta.get('songs')]);
        await db.transaction('rw', db.syncMeta, async () => {
            if (songs > 0) {
                await db.syncMeta.put({
                    EntityType: 'songs',
                    hydrationState: 'partial',
                    lastFullSyncAt: meta?.lastFullSyncAt,
                    lastSweepAt: meta?.lastSweepAt,
                    nextStartIndex: 0,
                    pausedUntil: undefined,
                    totalCount: meta?.totalCount,
                });
            }
            await db.syncMeta.put({
                EntityType: SONG_COVER_RESYNC_FLAG as EntityType,
                hydrationState: 'none',
                lastFullSyncAt: undefined,
                lastSweepAt: undefined,
                nextStartIndex: undefined,
                pausedUntil: undefined,
                totalCount: songs,
            });
        });
        if (songs === 0) return;
        useCacheStore.getState().actions.setHydrationState('songs', 'partial');
        // While the first-sync gate is still blocking, its runner owns
        // hydration and picks up the rewound cursor on its next attempt.
        const released = Boolean(
            useSettingsStore.getState().localCache?.firstSyncComplete?.[server.id],
        );
        console.info(`${TAG}: rewound songs for a one-shot full re-sync`, {
            previousState: meta?.hydrationState,
            serverId: server.id,
            songs,
            startingNow: released,
        });
        if (released) {
            void hydrate(server, 'full').catch((err) =>
                console.warn(`${TAG}: background hydrate failed`, err),
            );
        }
    } catch (err) {
        console.warn(`${TAG}: one-shot re-sync scheduling failed`, err);
    }
};
