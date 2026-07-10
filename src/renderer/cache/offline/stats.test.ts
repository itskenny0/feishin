import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { LibraryCacheDb } from '../db';
import { LocalMediaStore } from '../media-store';
import { useCacheStore } from '../store';
import { refreshOfflineAvailability, refreshOfflineStats } from './stats';

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`stats-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

describe('offline stats', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        store = await makeStore();
    });

    it('refreshOfflineStats publishes counts, availability, and normalized statuses', async () => {
        await store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:album:a1',
            serverId: 's',
            songId: 's1',
        });
        await store.putTarget({
            AddedAt: 0,
            Bytes: 10,
            DownloadedCount: 1,
            EntityId: 'a1',
            EntityType: 'album',
            Key: 's:album:a1',
            LastError: undefined,
            Name: 'A',
            ServerId: 's',
            SongCount: 1,
            // Legacy status must normalize to queued in the published map.
            Status: 'idle' as never,
            UpdatedAt: 0,
        });
        await refreshOfflineStats(store);
        const state = useCacheStore.getState();
        expect(state.offlineMedia.itemsDownloaded).toBe(1);
        expect(state.offlineMedia.targetCount).toBe(1);
        expect(state.offlineAvailability.songKeys.has('s:s1')).toBe(true);
        expect(state.offlineAvailability.entityKeys.has('s:album:a1')).toBe(true);
        expect(state.offlineTargetStatuses['s:album:a1']).toBe('queued');
    });

    it('refreshOfflineAvailability skips the store write when membership is unchanged', async () => {
        await store.save({
            blob: new Blob([new Uint8Array(4)]),
            container: 'mp3',
            entityKey: 's:album:a1',
            serverId: 's',
            songId: 's1',
        });
        await refreshOfflineAvailability(store);
        const first = useCacheStore.getState().offlineAvailability;
        await refreshOfflineAvailability(store);
        // Same membership → same object identity (no re-publish).
        expect(useCacheStore.getState().offlineAvailability).toBe(first);
    });
});
