import type {
    RemoteMirroredPlayState,
    RemotePlayCommand,
} from '/@/renderer/features/jellyfin-remote-target/types';
import type { AddToQueueType } from '/@/renderer/store';

import { isShuffleEnabled } from '/@/renderer/store/player.store';
import { Play, PlayerShuffle } from '/@/shared/types/types';

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

export interface RemoteTransfer {
    itemIds: string[];
    startIndex: number;
    startPositionTicks: number;
}

type TransferState = {
    player: { index: number; shuffle: PlayerShuffle };
    queue: { default: string[]; shuffled: number[]; songs: Record<string, { id: string }> };
};

/**
 * Capture the current local playback as a remote PlayNow push so selecting a
 * device continues where local left off. `player.index` is the position in the
 * playback-order queue in both shuffle states, so it maps directly onto the
 * ordered itemIds. Returns null when there's nothing to transfer.
 */
export const computeTransfer = (
    state: TransferState,
    positionSec: number,
): null | RemoteTransfer => {
    const shuffled = isShuffleEnabled(state);
    const orderedUids = shuffled
        ? state.queue.shuffled.map((i) => state.queue.default[i]).filter(Boolean)
        : state.queue.default;
    const itemIds = orderedUids
        .map((uid) => state.queue.songs[uid]?.id)
        .filter((id): id is string => Boolean(id));
    if (itemIds.length === 0) return null;
    const startIndex = Math.min(Math.max(0, state.player.index), itemIds.length - 1);
    return {
        itemIds,
        startIndex,
        startPositionTicks: Math.max(0, Math.round(positionSec * 10_000_000)),
    };
};

/**
 * Estimate the remote device's current position between 3s polls by advancing
 * the last sampled position by wall-clock elapsed time. Paused / never-sampled
 * states return the raw value. Clamped to `durationMs` when known.
 */
export const interpolatePositionMs = (
    playState: RemoteMirroredPlayState,
    now: number,
    durationMs: number | undefined,
): number => {
    const { isPaused, positionMs, positionSampledAt } = playState;
    if (isPaused || positionSampledAt === 0) return positionMs;
    const elapsed = now - positionSampledAt;
    const projected = elapsed > 0 ? positionMs + elapsed : positionMs;
    if (typeof durationMs === 'number' && durationMs > 0) {
        return Math.min(projected, durationMs);
    }
    return projected;
};
