// One-shot full re-sync of albums + songs for existing installs.
//
// Two fixes need rows that a finished sync never rewrites (once an entity is
// `full`, the sweep only runs a newest-first delta):
//  - albums + songs: Jellyfin 10.11 reports the page length as the total on
//    count-suppressed pages, so every sync stopped after ~1000 rows. The
//    missing (older) rows never arrive through a delta.
//  - songs: rows cached before tracks got their own cover identity were
//    normalized album-first (no `hasOwnCover`, no `OwnCoverId` index entry).
// Like the thumbnail miss-purge, this is a syncMeta-flagged one-shot (never a
// Dexie upgrade, which blocks DB-open): it rewinds each cached entity to a full
// name-ordered pass from index 0, after which the thumbnail sweep at the end of
// the same hydration caches the new covers. The sweep's own page checkpoints
// resume the pass across launches.

import type { ServerListItem } from '/@/shared/types/domain-types';

import type { LibraryCacheDb } from './db';
import type { EntityType } from './types';

import { useCacheStore } from './store';
import { hydrate } from './sync';

import { useSettingsStore } from '/@/renderer/store';

export const LIBRARY_RESYNC_FLAG = 'libraryResync_2026_11_v1';

const ENTITIES = ['albums', 'songs'] as const;
const TAG = '[cache] library resync';

export const scheduleLibraryResyncOnce = async (
    db: LibraryCacheDb,
    server: ServerListItem,
): Promise<void> => {
    try {
        if (await db.syncMeta.get(LIBRARY_RESYNC_FLAG as EntityType)) return;
        const counts = await Promise.all(ENTITIES.map((e) => db.table(e).count()));
        const metas = await Promise.all(ENTITIES.map((e) => db.syncMeta.get(e)));
        const rewound = ENTITIES.filter((_, i) => counts[i] > 0);
        await db.transaction('rw', db.syncMeta, async () => {
            for (const entity of rewound) {
                const meta = metas[ENTITIES.indexOf(entity)];
                await db.syncMeta.put({
                    EntityType: entity,
                    hydrationState: 'partial',
                    lastFullSyncAt: meta?.lastFullSyncAt,
                    lastSweepAt: meta?.lastSweepAt,
                    nextStartIndex: 0,
                    pausedUntil: undefined,
                    totalCount: meta?.totalCount,
                });
            }
            await db.syncMeta.put({
                EntityType: LIBRARY_RESYNC_FLAG as EntityType,
                hydrationState: 'none',
                lastFullSyncAt: undefined,
                lastSweepAt: undefined,
                nextStartIndex: undefined,
                pausedUntil: undefined,
                totalCount: undefined,
            });
        });
        if (rewound.length === 0) return;
        const { setHydrationState } = useCacheStore.getState().actions;
        for (const entity of rewound) setHydrationState(entity, 'partial');
        // While the first-sync gate is still blocking, its runner owns
        // hydration and picks up the rewound cursors on its next attempt.
        const released = Boolean(
            useSettingsStore.getState().localCache?.firstSyncComplete?.[server.id],
        );
        console.info(`${TAG}: rewound for a one-shot full re-sync`, {
            counts: Object.fromEntries(ENTITIES.map((e, i) => [e, counts[i]])),
            rewound,
            serverId: server.id,
            startingNow: released,
        });
        if (released) {
            void hydrate(server, 'full').catch((err) =>
                console.warn(`${TAG}: background hydrate failed`, err),
            );
        }
    } catch (err) {
        console.warn(`${TAG}: scheduling failed`, err);
    }
};
