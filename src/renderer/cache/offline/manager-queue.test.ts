import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import { LibraryCacheDb } from '../db';
import { LocalMediaStore } from '../media-store';
import { OfflineDownloadManager } from './manager';

let seq = 0;
const makeCtx = async () => {
    const db = new LibraryCacheDb(`mgr-queue-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

describe('OfflineDownloadManager queue ordering', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        store = await makeCtx();
    });

    it('processes queued targets FIFO and settles each', async () => {
        const processed: string[] = [];
        const mgr = new OfflineDownloadManager(() => store);
        mgr.setProcessHook(async (target) => {
            processed.push(target.Key);
            await store.patchTarget(target.Key, { EnqueuedAt: undefined, Status: 'complete' });
        });
        await mgr.enqueueMany([
            { entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' },
            { entityId: 'a2', entityType: 'album', name: 'B', serverId: 's' },
        ]);
        await mgr.whenIdle();
        expect(processed).toEqual(['s:album:a1', 's:album:a2']);
    });

    it('runs a Preempt target before earlier queued ones', async () => {
        const processed: string[] = [];
        const mgr = new OfflineDownloadManager(() => store);
        let first = true;
        mgr.setProcessHook(async (target) => {
            processed.push(target.Key);
            if (first) {
                first = false;
                // While processing the first target, enqueue + preempt a third.
                await store.putTarget({
                    AddedAt: 0,
                    Bytes: 0,
                    DownloadedCount: 0,
                    EnqueuedAt: 1,
                    EntityId: 'a3',
                    EntityType: 'album',
                    Key: 's:album:a3',
                    LastError: undefined,
                    Name: 'C',
                    Preempt: true,
                    ServerId: 's',
                    SongCount: undefined,
                    Status: 'queued',
                    UpdatedAt: 0,
                });
            }
            await store.patchTarget(target.Key, {
                EnqueuedAt: undefined,
                Preempt: false,
                Status: 'complete',
            });
        });
        await mgr.enqueueMany([
            { entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' },
            { entityId: 'a2', entityType: 'album', name: 'B', serverId: 's' },
        ]);
        await mgr.whenIdle();
        expect(processed).toEqual(['s:album:a1', 's:album:a3', 's:album:a2']);
    });
});
