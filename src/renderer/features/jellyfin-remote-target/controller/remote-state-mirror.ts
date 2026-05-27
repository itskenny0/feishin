import type {
    RemoteDevice,
    RemoteMirrored,
    RemoteMirroredPlayState,
} from '/@/renderer/features/jellyfin-remote-target/types';
import type { ServerListItemWithCredential, Song } from '/@/shared/types/domain-types';

import { remoteTargetApi } from '/@/renderer/features/jellyfin-remote-target/api/remote-target-api';
import { jfNormalize } from '/@/shared/api/jellyfin/jellyfin-normalize';

const MAX_QUEUE_HYDRATE = 200;

const ticksToMs = (ticks: number | undefined): number =>
    typeof ticks === 'number' ? Math.floor(ticks / 10_000) : 0;

/**
 * Build the play-state slice from a raw Jellyfin session.
 */
export const derivePlayState = (session: any): RemoteMirroredPlayState => ({
    isPaused: Boolean(session?.PlayState?.IsPaused),
    positionMs: ticksToMs(session?.PlayState?.PositionTicks),
    positionSampledAt: Date.now(),
    repeatMode:
        typeof session?.PlayState?.RepeatMode === 'string'
            ? session.PlayState.RepeatMode
            : 'RepeatNone',
    shuffle: session?.PlayState?.PlaybackOrder === 'Shuffle',
    volume:
        typeof session?.PlayState?.VolumeLevel === 'number' ? session.PlayState.VolumeLevel : 100,
});

export const deriveNowPlayingItem = (
    session: any,
    server: ServerListItemWithCredential,
): null | Song => {
    if (!session?.NowPlayingItem) return null;
    try {
        return jfNormalize.song(session.NowPlayingItem, server);
    } catch {
        return null;
    }
};

interface MirrorResult {
    /** Run this *after* the synchronous mirror is applied, to fill in the queue. */
    hydrateQueue: (() => Promise<Song[]>) | null;
    mirrored: Partial<RemoteMirrored>;
    /** Resolved index in the (post-hydrate) queue. -1 if not resolvable. */
    queueIndex: number;
}

/**
 * Compute the mirrored update for a single session payload.
 *
 * The caller does:
 *     actions.setMirrored(result.mirrored)
 *     if (result.hydrateQueue) {
 *         const queue = await result.hydrateQueue();
 *         actions.setMirrored({ queue, queueIndex: result.queueIndex });
 *     }
 */
export const mirrorSession = (
    session: any,
    server: ServerListItemWithCredential,
    previousQueueIds: string[],
): MirrorResult => {
    const playState = derivePlayState(session);
    const nowPlayingItem = deriveNowPlayingItem(session, server);
    const capabilities = Array.isArray(session?.SupportedCommands) ? session.SupportedCommands : [];

    const rawQueue: any[] = Array.isArray(session?.NowPlayingQueue) ? session.NowPlayingQueue : [];
    const queueIds = rawQueue
        .map((q) => q?.Id)
        .filter((id): id is string => typeof id === 'string');

    const queueChanged =
        queueIds.length !== previousQueueIds.length ||
        queueIds.some((id, i) => previousQueueIds[i] !== id);

    const result: MirrorResult = {
        hydrateQueue: null,
        mirrored: { capabilities, nowPlayingItem, playState },
        queueIndex: -1,
    };

    if (queueChanged && queueIds.length > 0) {
        const toFetch = queueIds.slice(0, MAX_QUEUE_HYDRATE);
        result.hydrateQueue = async () =>
            (await remoteTargetApi.hydrateSongs({ itemIds: toFetch, server })) as Song[];
        const currentItemId: null | string = session?.NowPlayingItem?.Id ?? null;
        result.queueIndex = currentItemId ? queueIds.indexOf(currentItemId) : -1;
    } else if (queueIds.length > 0) {
        // No re-hydrate; recompute index against existing queue.
        const currentItemId: null | string = session?.NowPlayingItem?.Id ?? null;
        result.queueIndex = currentItemId ? queueIds.indexOf(currentItemId) : -1;
        // Don't touch mirrored.queue at all when ids unchanged.
    }

    return result;
};

/**
 * Sift the full /Sessions response down to the session matching deviceId, if any.
 */
export const findSessionForDevice = (
    sessions: RemoteDevice[],
    deviceId: null | string,
): null | RemoteDevice => {
    if (!deviceId) return null;
    return sessions.find((s) => s.deviceId === deviceId) ?? null;
};
