import 'fake-indexeddb/auto';
import type { Mock } from 'vitest';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfflineTargetRow } from '../types';

import { LibraryCacheDb } from '../db';
import { LocalMediaStore } from '../media-store';
import { OfflineDownloadManager } from './manager';

import { api } from '/@/renderer/api';

vi.mock('/@/renderer/api', () => ({
    api: { controller: { getAlbumDetail: vi.fn() } },
}));

const getAlbumDetail = api.controller.getAlbumDetail as unknown as Mock;

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`ref-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

const completeAlbum = (downloaded: number): OfflineTargetRow => ({
    AddedAt: 0,
    Bytes: 10,
    DownloadedCount: downloaded,
    EntityId: 'a1',
    EntityType: 'album',
    Key: 's:album:a1',
    LastError: undefined,
    Name: 'A',
    ServerId: 's',
    SongCount: downloaded,
    Status: 'complete',
    UpdatedAt: 0,
});

describe('refreshTargets', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        store = await makeStore();
    });

    it('re-queues a complete album that gained songs', async () => {
        await store.putTarget(completeAlbum(1));
        getAlbumDetail.mockResolvedValue({ songs: [{ id: 's1' }, { id: 's2' }] }); // 1 → 2
        const mgr = new OfflineDownloadManager(() => store);
        const processed: string[] = [];
        mgr.setProcessHook(async (t) => {
            processed.push(t.Key);
            await store.patchTarget(t.Key, { EnqueuedAt: undefined, Status: 'complete' });
        });
        await mgr.refreshTargets();
        await mgr.whenIdle();
        expect(processed).toEqual(['s:album:a1']);
    });

    it('leaves a complete album that is unchanged', async () => {
        await store.putTarget(completeAlbum(2));
        getAlbumDetail.mockResolvedValue({ songs: [{ id: 's1' }, { id: 's2' }] });
        const mgr = new OfflineDownloadManager(() => store);
        const processed: string[] = [];
        mgr.setProcessHook(async (t) => {
            processed.push(t.Key);
        });
        await mgr.refreshTargets();
        await mgr.whenIdle();
        expect(processed).toEqual([]);
    });
});
