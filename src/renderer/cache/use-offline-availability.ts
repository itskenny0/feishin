// use-offline-availability — selectors over the in-memory offline-availability
// index (cache store) so list rows and detail headers can render the green
// "available offline" indicator without each hitting Dexie.
//
// The index is populated by the offline-media subsystem (refreshOfflineAvailability)
// whenever a download finishes or a target is removed. These hooks are pure
// store reads — cheap enough to call per-row in a virtualized list.

import type { OfflineEntityType } from '/@/renderer/cache/types';

import { blobKey, targetKey } from './media-store';
import { useCacheStore } from './store';

/**
 * Whether a single song has a downloaded blob available offline. `serverId`
 * and `songId` together form the blob key.
 */
export const useIsSongOfflineAvailable = (
    serverId: string | undefined,
    songId: string | undefined,
): boolean =>
    useCacheStore((s) =>
        serverId && songId ? s.offlineAvailability.songKeys.has(blobKey(serverId, songId)) : false,
    );

/**
 * Whether an entity (album / artist / genre / playlist / song) has anything
 * downloaded offline. For a `song` entity this is the per-blob check; for the
 * container types it's true once any of the entity's songs is on disk.
 */
export const useIsEntityOfflineAvailable = (
    serverId: string | undefined,
    entityType: OfflineEntityType | undefined,
    entityId: string | undefined,
): boolean =>
    useCacheStore((s) => {
        if (!serverId || !entityType || !entityId) return false;
        if (entityType === 'song') {
            return s.offlineAvailability.songKeys.has(blobKey(serverId, entityId));
        }
        return s.offlineAvailability.entityKeys.has(targetKey(serverId, entityType, entityId));
    });
