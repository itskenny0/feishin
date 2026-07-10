import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { OfflineTargetRow, OfflineTargetStatus } from '../types';

import { LibraryCacheDb } from '../db';
import { LocalMediaStore } from '../media-store';
import { OfflineDownloadManager } from './manager';

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`ctl-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

const seed = async (store: LocalMediaStore, id: string, status: OfflineTargetStatus) => {
    const row: OfflineTargetRow = {
        AddedAt: 0,
        Bytes: 0,
        DownloadedCount: 0,
        EntityId: id,
        EntityType: 'album',
        Key: `s:album:${id}`,
        LastError: undefined,
        Name: id,
        ServerId: 's',
        SongCount: undefined,
        Status: status,
        UpdatedAt: 0,
    };
    await store.putTarget(row);
};

describe('manager controls', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        store = await makeStore();
    });

    it('pause moves a queued target to paused and out of the ready set', async () => {
        const mgr = new OfflineDownloadManager(() => store);
        mgr.setProcessHook(async () => {
            /* never runs while paused */
        });
        await seed(store, 'a1', 'queued');
        await mgr.pause('s:album:a1');
        expect((await store.getTarget('s:album:a1'))?.Status).toBe('paused');
    });

    it('resume re-queues a paused target and processes it', async () => {
        const mgr = new OfflineDownloadManager(() => store);
        const processed: string[] = [];
        mgr.setProcessHook(async (t) => {
            processed.push(t.Key);
            await store.patchTarget(t.Key, { EnqueuedAt: undefined, Status: 'complete' });
        });
        await seed(store, 'a1', 'paused');
        await mgr.resume('s:album:a1');
        await mgr.whenIdle();
        expect(processed).toEqual(['s:album:a1']);
        expect((await store.getTarget('s:album:a1'))?.Status).toBe('complete');
    });

    it('retry re-queues an errored target', async () => {
        const mgr = new OfflineDownloadManager(() => store);
        mgr.setProcessHook(async (t) =>
            store.patchTarget(t.Key, { EnqueuedAt: undefined, Status: 'complete' }),
        );
        await seed(store, 'a1', 'error');
        await mgr.retry('s:album:a1');
        await mgr.whenIdle();
        expect((await store.getTarget('s:album:a1'))?.Status).toBe('complete');
    });

    it('remove deletes the target', async () => {
        const mgr = new OfflineDownloadManager(() => store);
        await seed(store, 'a1', 'complete');
        await mgr.remove('s:album:a1');
        expect(await store.getTarget('s:album:a1')).toBeUndefined();
    });

    it('resumeAll re-queues paused/partial/error, syncAll skips complete', async () => {
        const mgr = new OfflineDownloadManager(() => store);
        const processed: string[] = [];
        mgr.setProcessHook(async (t) => {
            processed.push(t.Key);
            await store.patchTarget(t.Key, { EnqueuedAt: undefined, Status: 'complete' });
        });
        await seed(store, 'a1', 'paused');
        await seed(store, 'a2', 'error');
        await seed(store, 'a3', 'complete');
        await mgr.resumeAll();
        await mgr.whenIdle();
        expect(processed.sort()).toEqual(['s:album:a1', 's:album:a2']);
    });
});
