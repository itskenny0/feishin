import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { OfflineTargetRow } from '../types';

import { LibraryCacheDb } from '../db';
import { LocalMediaStore } from '../media-store';
import { OfflineDownloadManager } from './manager';

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`res-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

const seed = async (store: LocalMediaStore, id: string, status: string) => {
    const row = {
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
    } as unknown as OfflineTargetRow;
    await store.putTarget(row);
};

describe('resumePersisted', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        store = await makeStore();
    });

    it('resumes legacy idle + crash-residue downloading, leaves complete alone', async () => {
        await seed(store, 'a1', 'idle'); // legacy → queued → processed
        await seed(store, 'a2', 'downloading'); // crash residue → queued → processed
        await seed(store, 'a3', 'complete'); // settled → untouched
        const processed: string[] = [];
        const mgr = new OfflineDownloadManager(() => store);
        mgr.setProcessHook(async (t) => {
            processed.push(t.Key);
            await store.patchTarget(t.Key, { EnqueuedAt: undefined, Status: 'complete' });
        });
        await mgr.resumePersisted();
        await mgr.whenIdle();
        expect(processed.sort()).toEqual(['s:album:a1', 's:album:a2']);
        expect((await store.getTarget('s:album:a3'))?.Status).toBe('complete');
    });
});
