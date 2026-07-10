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
            getStreamUrl: vi.fn(async () => 'http://x/audio'),
        },
    },
}));
// Mutable so a test can set a byte cap; 0 = unlimited.
const settings = vi.hoisted(() => ({ downloadOriginal: true, maxBytes: 0 }));
vi.mock('/@/renderer/store', () => ({
    useSettingsStore: {
        getState: () => ({ localCache: { offlineMedia: settings } }),
    },
}));

const getAlbumDetail = api.controller.getAlbumDetail as unknown as Mock;

const song = (id: string, over: Record<string, unknown> = {}) => ({
    container: 'flac',
    id,
    size: 10,
    updatedAt: '2026-01-01',
    ...over,
});

let seq = 0;
const makeStore = async () => {
    const db = new LibraryCacheDb(`dl-${(seq += 1)}`);
    await db.open();
    return new LocalMediaStore(() => db);
};

describe('processTarget', () => {
    let store: LocalMediaStore;
    beforeEach(async () => {
        settings.maxBytes = 0;
        store = await makeStore();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ blob: async () => new Blob([new Uint8Array(10)]), ok: true })),
        );
    });

    it('downloads all album songs and settles complete', async () => {
        getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        const t = await store.getTarget('s:album:a1');
        expect(t?.Status).toBe('complete');
        expect(t?.DownloadedCount).toBe(2);
        expect(await store.has('s', 's1')).toBe(true);
    });

    it('reuses an up-to-date blob from another target (dedup, no re-download)', async () => {
        // s1 already downloaded under a DIFFERENT target, with a matching tag.
        await store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:playlist:other',
            serverId: 's',
            songId: 's1',
            sourceTag: { size: 10, updatedAt: '2026-01-01' },
        });
        const fetchSpy = fetch as unknown as Mock;
        fetchSpy.mockClear();
        getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        // s1 dedup-skipped → only s2 fetched.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const t = await store.getTarget('s:album:a1');
        expect(t?.Status).toBe('complete');
        expect(t?.SharedCount).toBe(1);
        // s1's blob now references both targets.
        const blob = await store.get('s', 's1');
        expect(blob?.EntityKeys).toEqual(
            expect.arrayContaining(['s:playlist:other', 's:album:a1']),
        );
    });

    it('resume with pre-existing blobs settles with ground-truth counts (no overflow)', async () => {
        // s1 already downloaded for THIS target (a partial download resumed).
        await store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:album:a1',
            serverId: 's',
            songId: 's1',
            sourceTag: { size: 10, updatedAt: '2026-01-01' },
        });
        const fetchSpy = fetch as unknown as Mock;
        fetchSpy.mockClear();
        getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        const t = await store.getTarget('s:album:a1');
        expect(fetchSpy).toHaveBeenCalledTimes(1); // only s2 (s1 up to date)
        expect(t?.Status).toBe('complete');
        expect(t?.SongCount).toBe(2);
        expect(t?.DownloadedCount).toBe(2); // NOT 2/1 overflow
    });

    it('re-downloads a stale blob (fingerprint clearly differs)', async () => {
        // s1 present but with an old fingerprint (different updatedAt).
        await store.save({
            blob: new Blob([new Uint8Array(10)]),
            container: 'flac',
            entityKey: 's:album:a1',
            serverId: 's',
            songId: 's1',
            sourceTag: { size: 10, updatedAt: '2020-01-01' },
        });
        const fetchSpy = fetch as unknown as Mock;
        fetchSpy.mockClear();
        // Live song has a newer updatedAt → stale → must re-download.
        getAlbumDetail.mockResolvedValue({ songs: [song('s1', { updatedAt: '2026-06-01' })] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        expect(fetchSpy).toHaveBeenCalledTimes(1); // re-fetched the stale song
        const blob = await store.get('s', 's1');
        expect(blob?.SourceTag?.updatedAt).toBe('2026-06-01'); // fresh fingerprint
        expect((await store.getTarget('s:album:a1'))?.Status).toBe('complete');
    });

    it('pausing during enumeration leaves the target paused, not error', async () => {
        // getAlbumDetail hangs until its signal aborts, so the target is stuck
        // in the enumerating phase when we pause it.
        getAlbumDetail.mockImplementation(
            ({ apiClientProps }: { apiClientProps: { signal?: AbortSignal } }) =>
                new Promise((_resolve, reject) => {
                    apiClientProps.signal?.addEventListener('abort', () =>
                        reject(new DOMException('aborted', 'AbortError')),
                    );
                }),
        );
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await vi.waitFor(async () =>
            expect((await store.getTarget('s:album:a1'))?.Status).toBe('enumerating'),
        );
        await mgr.pause('s:album:a1');
        await mgr.whenIdle();
        expect((await store.getTarget('s:album:a1'))?.Status).toBe('paused');
    });

    it('stops at the byte cap and marks the target partial', async () => {
        // Cap fits one 10-byte song but not two.
        settings.maxBytes = 15;
        getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const mgr = new OfflineDownloadManager(() => store);
        await mgr.enqueue({ entityId: 'a1', entityType: 'album', name: 'A', serverId: 's' });
        await mgr.whenIdle();
        const t = await store.getTarget('s:album:a1');
        expect(t?.Status).toBe('partial');
        expect(t?.DownloadedCount).toBe(1);
        expect(t?.LastError).toBe('Storage cap reached');
    });
});
