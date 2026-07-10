import 'fake-indexeddb/auto';
import type { Mock } from 'vitest';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LibraryCacheDb } from '../db';
import { LocalMediaStore } from '../media-store';
import { OfflineDownloadManager } from './manager';

import { api } from '/@/renderer/api';

vi.mock('/@/renderer/api', () => ({
    api: {
        controller: {
            getAlbumDetail: vi.fn(),
            getStreamUrl: vi.fn(async () => 'http://x/a'),
        },
    },
}));
vi.mock('/@/renderer/store', () => ({
    useSettingsStore: {
        getState: () => ({ localCache: { offlineMedia: { downloadOriginal: true, maxBytes: 0 } } }),
    },
}));

const getAlbumDetail = api.controller.getAlbumDetail as unknown as Mock;
const song = (id: string) => ({ container: 'flac', id, size: 5, updatedAt: '2026-01-01' });

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`bc-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

// A pre-overhaul blob has NO SourceTag. Persist one directly.
const seedLegacyBlob = async (store: LocalMediaStore, songId: string, entityKey: string) => {
    await store.save({
        blob: new Blob([new Uint8Array(5)]),
        container: 'flac',
        entityKey,
        serverId: 's',
        songId,
        // deliberately no sourceTag → legacy row
    });
};

describe('backward compatibility: pre-overhaul blobs are never re-downloaded', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        store = await makeStore();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array(5)]), ok: true })),
        );
    });

    it('a legacy blob under the same target is reused on re-sync (resume seed)', async () => {
        await seedLegacyBlob(store, 's1', 's:album:a1');
        const fetchSpy = fetch as unknown as Mock;
        fetchSpy.mockClear();
        getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        expect(fetchSpy).toHaveBeenCalledTimes(1); // only s2
        expect((await store.getTarget('s:album:a1'))?.Status).toBe('complete');
        expect(await store.has('s', 's1')).toBe(true);
    });

    it('a legacy blob under a different target is reused via isUpToDate (no re-fetch)', async () => {
        await seedLegacyBlob(store, 's1', 's:playlist:other');
        const fetchSpy = fetch as unknown as Mock;
        fetchSpy.mockClear();
        getAlbumDetail.mockResolvedValue({ songs: [song('s1')] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        expect(fetchSpy).not.toHaveBeenCalled(); // legacy blob (no SourceTag) reused
        const blob = await store.get('s', 's1');
        expect(blob?.EntityKeys).toEqual(
            expect.arrayContaining(['s:playlist:other', 's:album:a1']),
        );
    });
});
