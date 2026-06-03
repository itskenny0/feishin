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
        setOfflineAvailability: vi.fn(),
        setOfflineMedia: vi.fn(),
        setOfflineSync: vi.fn(),
    };
    // Mutable mirror of the store's availability slice so refreshOfflineAvailability's
    // "skip when unchanged" equality check has a previous value to compare against.
    const cacheState = {
        offlineAvailability: { entityKeys: new Set<string>(), songKeys: new Set<string>() },
    };
    const ref = {
        cacheActions,
        cacheState,
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
    useCacheStore: {
        getState: () => ({
            actions: mocks.cacheActions,
            offlineAvailability: mocks.cacheState.offlineAvailability,
        }),
    },
}));

import { LocalMediaStore } from '/@/renderer/cache/media-store';
import {
    addOfflineTarget,
    cancelOfflineSync,
    enumerateTargetSongs,
    refreshOfflineAvailability,
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
    mocks.cacheState.offlineAvailability = { entityKeys: new Set(), songKeys: new Set() };
    mocks.cacheActions.setOfflineAvailability.mockImplementation((a: any) => {
        mocks.cacheState.offlineAvailability = a;
    });
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

describe('refreshOfflineAvailability', () => {
    it('publishes downloaded song keys + owning entity keys to the store', async () => {
        const store = makeStore();
        await store.save({
            blob: new Blob([new Uint8Array(100)]),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });

        await refreshOfflineAvailability(store);

        expect(mocks.cacheActions.setOfflineAvailability).toHaveBeenCalledTimes(1);
        const published = mocks.cacheActions.setOfflineAvailability.mock.calls[0][0];
        expect([...published.songKeys]).toEqual(['srv:s1']);
        expect([...published.entityKeys]).toEqual(['srv:album:al1']);
    });

    it('skips the store write when membership is unchanged', async () => {
        const store = makeStore();
        await store.save({
            blob: new Blob([new Uint8Array(100)]),
            container: 'mp3',
            entityKey: 'srv:album:al1',
            serverId: 'srv',
            songId: 's1',
        });

        await refreshOfflineAvailability(store); // first call publishes
        await refreshOfflineAvailability(store); // second is a no-op

        expect(mocks.cacheActions.setOfflineAvailability).toHaveBeenCalledTimes(1);
    });

    it('is refreshed automatically after a target download completes', async () => {
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const store = makeStore();
        await store.putTarget(target());

        await syncTarget({ store, target: target() });

        // syncTarget → finish → refreshOfflineStats → refreshOfflineAvailability.
        expect(mocks.cacheActions.setOfflineAvailability).toHaveBeenCalled();
        const last = mocks.cacheActions.setOfflineAvailability.mock.calls.at(-1)![0];
        expect([...last.songKeys].sort()).toEqual(['srv:s1', 'srv:s2']);
        expect([...last.entityKeys]).toEqual(['srv:album:e1']);
    });
});

describe('byte-cap reservation accounting', () => {
    it('counts only NEW bytes (a blob shared with another target adds zero)', async () => {
        // s1 is already on disk under a DIFFERENT target (playlist). The album
        // sync re-references it (membership only, no new bytes) then downloads
        // s2. With the reservation released for the shared blob, the album's
        // tracked Bytes reflects only the genuinely-new s2 download — the
        // shared s1 does not inflate the album's byte accounting or eat cap
        // headroom it never used.
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const store = makeStore();
        await store.putTarget(target());
        await store.save({
            blob: new Blob([new Uint8Array(1000)]),
            container: 'mp3',
            entityKey: 'srv:playlist:pl1',
            serverId: 'srv',
            songId: 's1',
        });

        const result = await syncTarget({ store, target: target() });

        // Both songs are now referenced by the album, but only s2's 1000
        // bytes are attributed as NEW to this target.
        expect(await store.has('srv', 's1')).toBe(true);
        expect(await store.has('srv', 's2')).toBe(true);
        expect(result.Bytes).toBe(1000);
        expect(result.Status).toBe('complete');
        // s1's blob is now shared by both the playlist and the album target.
        const s1 = await store.get('srv', 's1');
        expect(s1?.EntityKeys.sort()).toEqual(['srv:album:e1', 'srv:playlist:pl1']);
    });
});
