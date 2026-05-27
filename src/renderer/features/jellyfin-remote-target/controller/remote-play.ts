import type { RemotePlayCommand } from '/@/renderer/features/jellyfin-remote-target/types';
import type { AddToQueueType } from '/@/renderer/store';

import { Play } from '/@/shared/types/types';

export interface RemotePlayPush {
    itemIds: string[];
    playCommand: RemotePlayCommand;
    startIndex?: number;
}

/**
 * Translate a local "add to queue / play" intent into a Jellyfin remote push,
 * or null if it cannot/should not be sent remotely (empty set, or a queue-
 * reorder edge object — Jellyfin has no remote reorder surface).
 */
export const computeRemotePlay = (
    songs: { id: string }[],
    type: AddToQueueType,
    playSongId?: string,
): null | RemotePlayPush => {
    if (typeof type === 'object') return null;
    const itemIds = songs.map((s) => s.id);
    if (itemIds.length === 0) return null;

    const playCommand: RemotePlayCommand =
        type === Play.NEXT ? 'PlayNext' : type === Play.LAST ? 'PlayLast' : 'PlayNow';

    let startIndex: number | undefined;
    if (playCommand === 'PlayNow' && playSongId) {
        const idx = itemIds.indexOf(playSongId);
        if (idx > 0) startIndex = idx;
    }

    return { itemIds, playCommand, startIndex };
};
