import type { QueueData, QueueSong } from '/@/shared/types/domain-types';
import type { PersistStorage } from 'zustand/middleware';

import { del, get, set } from 'idb-keyval';
import mergeWith from 'lodash/mergeWith';

import { logger } from '/@/renderer/utils/logger';

type PlayerStorePersistedSlice = {
    player?: unknown;
    queue?: QueueData;
};

export function cleanQueueForPersistence(queue: QueueData): QueueData {
    const allQueueIds = new Set(queue.default || []);
    const songs = queue.songs || {};
    const cleanedSongs: Record<string, QueueSong> = {};

    for (const [id, song] of Object.entries(songs)) {
        if (allQueueIds.has(id)) {
            cleanedSongs[id] = song;
        }
    }

    return {
        ...queue,
        songs: cleanedSongs,
    };
}

// Migrate from v3 to v4 to handle queue migration
export async function migratePlayerStorePersist(storeName: string): Promise<void> {
    const mainRaw = await get(storeName);
    if (!mainRaw) {
        return;
    }

    let parsed: { state?: { player?: unknown; queue?: QueueData }; version?: number };
    try {
        parsed = JSON.parse(mainRaw as string);
    } catch {
        return;
    }

    const embeddedQueue = parsed.state?.queue;
    if (embeddedQueue === undefined) {
        return;
    }

    const queueKey = `${storeName}-queue`;
    const queueSeparateRaw = await get(queueKey);

    if (!queueSeparateRaw) {
        const cleaned = cleanQueueForPersistence(embeddedQueue);
        await set(queueKey, JSON.stringify(cleaned));
    }

    await set(
        storeName,
        JSON.stringify({
            state: { player: parsed.state?.player },
            version: parsed.version,
        }),
    );
}

function playerStoreQueueKey(storeName: string): string {
    return `${storeName}-queue`;
}

let lastPersistedPlayerQueueRef: QueueData | undefined;

export const playerStoreStorage: PersistStorage<unknown> = {
    getItem: async (name) => {
        const mainRaw = await get(name);
        if (!mainRaw) {
            return null;
        }

        let parsed: { state?: { player?: unknown; queue?: QueueData }; version?: number };
        try {
            parsed = JSON.parse(mainRaw as string);
        } catch (error) {
            logger.warn('Failed to parse player store', { error: String(error) });
            return null;
        }

        const version = parsed.version;
        let queue: QueueData | undefined;
        const queueRaw = await get(playerStoreQueueKey(name));

        if (queueRaw) {
            try {
                queue = JSON.parse(queueRaw as string) as QueueData;
            } catch (error) {
                logger.warn('Failed to parse player queue', { error: String(error) });
                queue = undefined;
            }
        } else if (parsed.state?.queue) {
            // Fallback to legacy format if queue is not found
            queue = parsed.state.queue;
        }

        return {
            state: {
                player: parsed.state?.player,
                queue,
            } satisfies PlayerStorePersistedSlice,
            version,
        };
    },

    removeItem: async (name) => {
        lastPersistedPlayerQueueRef = undefined;
        await del(name);
        await del(playerStoreQueueKey(name));
    },

    setItem: async (name, value) => {
        const { state: rawState, version } = value;
        const state = rawState as PlayerStorePersistedSlice;
        const player = state.player;

        await set(
            name,
            JSON.stringify({
                state: { player },
                version,
            }),
        );

        if (state.queue === undefined) {
            lastPersistedPlayerQueueRef = undefined;
            await del(playerStoreQueueKey(name));
            return;
        }

        if (state.queue === lastPersistedPlayerQueueRef) {
            return;
        }

        const cleaned = cleanQueueForPersistence(state.queue);
        await set(playerStoreQueueKey(name), JSON.stringify(cleaned));
        lastPersistedPlayerQueueRef = state.queue;
    },
};

/**
 * A custom deep merger that will replace all 'columns' items with the persistent
 * state, instead of the default merge behavior. This is important to preserve the user's
 * order, and not lead to an inconsistent state (e.g. multiple 'Favorite' keys)
 * @param persistedState the persistent state
 * @param currentState the current state
 * @returns the a custom deep merge
 */
export const mergeOverridingColumns = <T>(persistedState: unknown, currentState: T) => {
    return mergeWith(currentState, persistedState, (_original, persistent, key) => {
        if (key === 'columns') {
            return persistent;
        }

        return undefined;
    });
};
