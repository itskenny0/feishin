import { describe, expect, it } from 'vitest';

import { useCacheStore } from '../store';
import { publishProgress, publishQueue } from './progress';

describe('offline progress publishing', () => {
    it('publishProgress writes offlineSync with phase + foundCount', () => {
        publishProgress({
            bytesDownloaded: 0,
            bytesPerSec: 0,
            done: 0,
            entityKey: 's:album:a1',
            estimatedTotalBytes: undefined,
            foundCount: 12,
            itemsPerSec: 0,
            name: 'Album',
            phase: 'enumerating',
            startedAt: 1,
            total: undefined,
        });
        expect(useCacheStore.getState().offlineSync?.phase).toBe('enumerating');
        expect(useCacheStore.getState().offlineSync?.foundCount).toBe(12);
        publishProgress(undefined);
        expect(useCacheStore.getState().offlineSync).toBeUndefined();
    });

    it('publishQueue writes and clears the queue summary', () => {
        publishQueue({ activeKey: 's:album:a1', queuedCount: 4, targetsDone: 1, targetsTotal: 6 });
        expect(useCacheStore.getState().offlineQueue?.queuedCount).toBe(4);
        publishQueue(undefined);
        expect(useCacheStore.getState().offlineQueue).toBeUndefined();
    });
});
