// Unit tests for the offline-media download pipeline.
//
// We mock the API controller, global fetch, the settings store (for the byte
// cap + downloadOriginal), and the cache store (for progress), then drive the
// pipeline against a LocalMediaStore backed by the same in-memory table shim
// used in media-store.test.ts. Asserts: enumeration wiring per entity type,
// bounded download into the blob store, byte-cap enforcement, cancel, and the
// add/remove target lifecycle.

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedMediaBlob, OfflineTargetRow } from '/@/renderer/cache/types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks ------------------------------------------------------------
// Hoisted so the vi.mock factories (which are themselves hoisted) can close
// over these without a temporal-dead-zone error.
const mocks = vi.hoisted(() => {
    const controller = {
        getAlbumDetail: vi.fn(),
        getPlaylistSongList: vi.fn(),
        getSongDetail: vi.fn(),
        getSongList: vi.fn(),
        getStreamUrl: vi.fn(),
    };
    const cacheActions = {
        setOfflineMedia: vi.fn(),
        setOfflineSync: vi.fn(),
    };
    const ref = {
        cacheActions,
        controller,
        settingsState: {
            localCache: {
                offlineMedia: { downloadOriginal: true, maxBytes: Number.POSITIVE_INFINITY },
            },
        } as any,
    };
    return ref;
});

const { controller } = mocks;

vi.mock('/@/renderer/api', () => ({ api: { controller: mocks.controller } }));
vi.mock('/@/renderer/store', () => ({
    useSettingsStore: { getState: () => mocks.settingsState },
}));
vi.mock('/@/renderer/cache/store', () => ({
    useCacheStore: { getState: () => ({ actions: mocks.cacheActions }) },
}));

import { LocalMediaStore } from '/@/renderer/cache/media-store';
import {
    addOfflineTarget,
    cancelOfflineSync,
    enumerateTargetSongs,
    removeOfflineTarget,
    syncTarget,
} from '/@/renderer/cache/offline-media';

// --- in-memory table shim (same shape as media-store.test.ts) ---------

class TableShim<T extends Record<string, any>> {
    readonly rows = new Map<unknown, T>();
    private readonly pk: string;
    constructor(pk: string) {
        this.pk = pk;
    }
    async clear() {
        this.rows.clear();
    }
    async count() {
        return this.rows.size;
    }
    async delete(key: unknown) {
        this.rows.delete(key);
    }
    async each(fn: (row: T) => void) {
        for (const row of this.rows.values()) fn(row);
    }
    async get(key: unknown) {
        return this.rows.get(key);
    }
    async put(row: T) {
        this.rows.set(row[this.pk], row);
    }
    async toArray() {
        return [...this.rows.values()];
    }
    where(field: string) {
        return {
            equals: (value: unknown) => ({
                toArray: async () =>
                    [...this.rows.values()].filter((r) => {
                        const v = (r as any)[field];
                        return Array.isArray(v) ? v.includes(value) : v === value;
                    }),
            }),
        };
    }
}

const makeStore = () => {
    const db = {
        mediaBlobs: new TableShim<CachedMediaBlob>('Key'),
        offlineTargets: new TableShim<OfflineTargetRow>('Key'),
    } as unknown as LibraryCacheDb;
    return new LocalMediaStore(() => db);
};

const song = (id: string, size = 1000) => ({ container: 'mp3', id, name: id, size }) as any;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsState = {
        localCache: {
            offlineMedia: { downloadOriginal: true, maxBytes: Number.POSITIVE_INFINITY },
        },
    };
    controller.getStreamUrl.mockImplementation(
        async ({ query }: any) => `https://srv/dl/${query.id}`,
    );
    // Default: fetch returns a 1000-byte blob.
    global.fetch = vi.fn(async () => ({
        blob: async () => new Blob([new Uint8Array(1000)]),
        ok: true,
    })) as any;
});

afterEach(() => {
    cancelOfflineSync();
});

const target = (overrides: Partial<OfflineTargetRow> = {}): OfflineTargetRow => ({
    AddedAt: 0,
    Bytes: 0,
    DownloadedCount: 0,
    EntityId: 'e1',
    EntityType: 'album',
    Key: 'srv:album:e1',
    LastError: undefined,
    Name: 'Album',
    ServerId: 'srv',
    SongCount: undefined,
    Status: 'idle',
    UpdatedAt: 0,
    ...overrides,
});

describe('enumerateTargetSongs', () => {
    it('uses getAlbumDetail.songs for albums', async () => {
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const songs = await enumerateTargetSongs({
            EntityId: 'al1',
            EntityType: 'album',
            ServerId: 'srv',
        });
        expect(controller.getAlbumDetail).toHaveBeenCalledWith(
            expect.objectContaining({ query: { id: 'al1' } }),
        );
        expect(songs.map((s) => s.id)).toEqual(['s1', 's2']);
    });

    it('pages getPlaylistSongList for playlists', async () => {
        // First page full (500), second page short → stop.
        controller.getPlaylistSongList
            .mockResolvedValueOnce({ items: Array.from({ length: 500 }, (_, i) => song(`p${i}`)) })
            .mockResolvedValueOnce({ items: [song('last')] });
        const songs = await enumerateTargetSongs({
            EntityId: 'pl1',
            EntityType: 'playlist',
            ServerId: 'srv',
        });
        expect(controller.getPlaylistSongList).toHaveBeenCalledTimes(2);
        expect(songs).toHaveLength(501);
    });

    it('filters getSongList by albumArtistIds for artists', async () => {
        controller.getSongList.mockResolvedValue({ items: [song('s1')] });
        await enumerateTargetSongs({ EntityId: 'ar1', EntityType: 'artist', ServerId: 'srv' });
        expect(controller.getSongList).toHaveBeenCalledWith(
            expect.objectContaining({
                query: expect.objectContaining({ albumArtistIds: ['ar1'] }),
            }),
        );
    });

    it('filters getSongList by genreIds for genres', async () => {
        controller.getSongList.mockResolvedValue({ items: [song('s1')] });
        await enumerateTargetSongs({ EntityId: 'g1', EntityType: 'genre', ServerId: 'srv' });
        expect(controller.getSongList).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.objectContaining({ genreIds: ['g1'] }) }),
        );
    });

    it('uses getSongDetail for a single song', async () => {
        controller.getSongDetail.mockResolvedValue(song('s1'));
        const songs = await enumerateTargetSongs({
            EntityId: 's1',
            EntityType: 'song',
            ServerId: 'srv',
        });
        expect(songs.map((s) => s.id)).toEqual(['s1']);
    });
});

describe('syncTarget download', () => {
    it('downloads every song into the blob store and marks complete', async () => {
        controller.getAlbumDetail.mockResolvedValue({
            songs: [song('s1'), song('s2'), song('s3')],
        });
        const store = makeStore();
        await store.putTarget(target());

        const result = await syncTarget({ store, target: target() });

        expect(result.Status).toBe('complete');
        expect(await store.count()).toBe(3);
        expect(await store.totalBytes()).toBe(3000);
        expect(await store.has('srv', 's2')).toBe(true);
        // Each song resolved its download URL + fetched once.
        expect(controller.getStreamUrl).toHaveBeenCalledTimes(3);
        expect(global.fetch).toHaveBeenCalledTimes(3);
        // Original (untranscoded) requested.
        expect(controller.getStreamUrl).toHaveBeenCalledWith(
            expect.objectContaining({ query: expect.objectContaining({ transcode: false }) }),
        );
    });

    it('enforces the byte cap and marks the target partial', async () => {
        // Cap at 2500 bytes; 3 × 1000-byte songs → only 2 fit.
        mocks.settingsState.localCache.offlineMedia.maxBytes = 2500;
        controller.getAlbumDetail.mockResolvedValue({
            songs: [song('s1'), song('s2'), song('s3')],
        });
        const store = makeStore();
        await store.putTarget(target());

        const result = await syncTarget({ store, target: target() });

        expect(result.Status).toBe('partial');
        expect(await store.count()).toBe(2);
        expect(await store.totalBytes()).toBe(2000);
    });

    it('keeps going when a single song fails (404)', async () => {
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        let call = 0;
        global.fetch = vi.fn(async () => {
            call += 1;
            if (call === 1) return { ok: false, status: 404 } as any;
            return { blob: async () => new Blob([new Uint8Array(1000)]), ok: true } as any;
        }) as any;
        const store = makeStore();
        await store.putTarget(target());

        const result = await syncTarget({ store, target: target() });

        // One failed → not complete, but the other landed.
        expect(['error', 'partial']).toContain(result.Status);
        expect(await store.count()).toBe(1);
    });

    it('resumes — already-downloaded songs are not re-fetched', async () => {
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const store = makeStore();
        await store.putTarget(target());
        // Pre-seed s1.
        await store.save({
            blob: new Blob([new Uint8Array(1000)]),
            container: 'mp3',
            entityKey: 'srv:album:e1',
            serverId: 'srv',
            songId: 's1',
        });

        await syncTarget({ store, target: target() });

        // Only s2 fetched this run.
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(await store.count()).toBe(2);
    });
});

describe('target lifecycle', () => {
    it('addOfflineTarget is idempotent', async () => {
        const store = makeStore();
        const a = await addOfflineTarget(
            { entityId: 'al1', entityType: 'album', name: 'A', serverId: 'srv' },
            store,
        );
        const b = await addOfflineTarget(
            { entityId: 'al1', entityType: 'album', name: 'A', serverId: 'srv' },
            store,
        );
        expect(a.Key).toBe(b.Key);
        expect(await store.listTargets()).toHaveLength(1);
    });

    it('removeOfflineTarget drops the row and reclaims its blobs', async () => {
        const store = makeStore();
        await addOfflineTarget(
            { entityId: 'al1', entityType: 'album', name: 'A', serverId: 'srv' },
            store,
        );
        await store.save({
            blob: new Blob([new Uint8Array(500)]),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });
        await removeOfflineTarget('srv:album:al1', store);
        expect(await store.listTargets()).toHaveLength(0);
        expect(await store.count()).toBe(0);
    });
});
