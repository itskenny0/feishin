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
        setOfflineTargetStatus: vi.fn(),
        setOfflineTargetStatuses: vi.fn(),
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
    isSyncing,
    refreshOfflineAvailability,
    removeOfflineTarget,
    syncTarget,
} from '/@/renderer/cache/offline-media';

// --- in-memory table shim (same shape as media-store.test.ts) ---------

// `*`-prefixed (multiEntry) indexes per the v9 mediaBlobs schema in db.ts.
const MEDIA_BLOBS_MULTI_ENTRY = new Set(['EntityKeys']);

class TableShim<T extends Record<string, any>> {
    readonly rows = new Map<unknown, T>();
    private readonly multiEntry: Set<string>;
    private readonly pk: string;
    constructor(pk: string, multiEntry: Set<string> = new Set()) {
        this.pk = pk;
        this.multiEntry = multiEntry;
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
    // See media-store.test.ts: `.keys()` returns INDEX keys only (no row, no
    // Blob); multiEntry indexes expand array fields per element.
    orderBy(field: string) {
        return {
            keys: async (): Promise<Array<number | string>> => {
                const out: Array<number | string> = [];
                for (const row of this.rows.values()) {
                    const v = (row as any)[field];
                    if (this.multiEntry.has(field)) {
                        if (Array.isArray(v)) {
                            for (const el of v) out.push(el);
                        }
                    } else if (v !== undefined) {
                        out.push(v);
                    }
                }
                return out;
            },
        };
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
        mediaBlobs: new TableShim<CachedMediaBlob>('Key', MEDIA_BLOBS_MULTI_ENTRY),
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

    it('releases the FULL reconciled reservation when a store write throws after fetch', async () => {
        // Regression: the error path released a flat `projected` reservation,
        // but if the write threw AFTER the reservation was reconciled up to the
        // real (larger) blob size, the difference leaked into reservedBytes and
        // permanently ate cap headroom — starving a later song in the same
        // sync. Here s1's reported size is small (projected 500) but its real
        // blob is large (2000) and its store.save() throws. With a correct
        // FULL release there is still room for the remaining small song; with
        // the buggy `projected`-only release the leaked 1500 trips the cap.
        //
        // Cap = 2750. Real sizes: s1=2000 (fails to save), then s2,s3,s4=500.
        // Committed bytes if everything that *can* download does: s2+s3+s4 =
        // 1500 — well under 2750. With the fix, s1's catch releases the full
        // reconciled 2000, so when worker A loops to s4 the live reservation is
        // 1500 (s2+s3 in flight) and s4's pre-check 1500+500=2000 < 2750 → ok.
        // With the bug, s1's catch releases only `projected` (500), leaving a
        // 1500 leak; s4's pre-check sees 2500+500=3000 > 2750 → capHit → s4 is
        // skipped and the target is wrongly marked partial.
        mocks.settingsState.localCache.offlineMedia.maxBytes = 2750;
        controller.getAlbumDetail.mockResolvedValue({
            songs: [song('s1', 500), song('s2', 500), song('s3', 500), song('s4', 500)],
        });

        // Real blob sizes per song id.
        const realSize: Record<string, number> = { s1: 2000, s2: 500, s3: 500, s4: 500 };
        // s1 resolves immediately; the others gate on `release` so worker A
        // finishes s1 (fails) and loops to pick s4 with s1's reservation state
        // already settled.
        let release = (): void => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        global.fetch = vi.fn(async (url: any) => {
            const id = String(url).split('/').pop() as string;
            if (id !== 's1') await gate;
            return {
                blob: async () => new Blob([new Uint8Array(realSize[id])]),
                ok: true,
            } as any;
        }) as any;

        const store = makeStore();
        // Make ONLY s1's save throw, after its (large) blob has been fetched.
        const realSave = store.save.bind(store);
        store.save = (async (a: any) => {
            if (a.songId === 's1') throw new Error('disk write failed');
            return realSave(a);
        }) as any;
        await store.putTarget(target());

        const p = syncTarget({ store, target: target() });
        // Let s1 fail and worker A advance before unblocking the rest.
        await new Promise((r) => setTimeout(r, 0));
        release();
        const result = await p;

        // s1 failed; s2,s3,s4 must ALL have downloaded — the failed s1's
        // reservation was fully released so it never blocked the remaining
        // songs against the 3000 cap.
        expect(await store.has('srv', 's1')).toBe(false);
        expect(await store.has('srv', 's2')).toBe(true);
        expect(await store.has('srv', 's3')).toBe(true);
        expect(await store.has('srv', 's4')).toBe(true);
        expect(await store.count()).toBe(3);
        // One genuine failure → status is 'error', not 'partial' (cap).
        expect(result.Status).toBe('error');
    });
});

describe('same-key re-sync race', () => {
    it('a superseding same-key sync stays cancellable; the stale one cannot clobber it', async () => {
        // Regression: starting a second sync for the SAME key used to NOT
        // cancel the first (the guard was `activeKey !== key`), so two worker
        // pools ran against one target and the first pool's finish() — keyed
        // only by `key` — wiped the second pool's abort controller, leaving the
        // live sync un-cancellable (isSyncing() === false). The fix always
        // cancels the in-flight sync and gates finish() on controller identity.
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });

        // Hang every fetch until released so both syncs stay in-flight, but
        // honour the abort signal so an aborted (superseded) sync's workers
        // unwind instead of hanging on the gate forever.
        let release = (): void => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        global.fetch = vi.fn(
            (_url: any, opts: any) =>
                new Promise((resolve, reject) => {
                    const signal: AbortSignal | undefined = opts?.signal;
                    if (signal?.aborted) {
                        reject(new DOMException('Aborted', 'AbortError'));
                        return;
                    }
                    signal?.addEventListener('abort', () =>
                        reject(new DOMException('Aborted', 'AbortError')),
                    );
                    void gate.then(() =>
                        resolve({
                            blob: async () => new Blob([new Uint8Array(1000)]),
                            ok: true,
                        } as any),
                    );
                }),
        ) as any;

        const store = makeStore();
        await store.putTarget(target());

        // Sync A (will be superseded). Don't await — it hangs on the gate.
        let aSettled = false;
        const a = syncTarget({ store, target: target() }).finally(() => {
            aSettled = true;
        });
        await new Promise((r) => setTimeout(r, 0));
        // Sync B for the SAME key. Must cancel A first.
        const b = syncTarget({ store, target: target() });
        await new Promise((r) => setTimeout(r, 0));

        // B is the live sync we expect to be running and cancellable.
        expect(isSyncing()).toBe(true);

        // A must settle PROMPTLY without the gate ever being released — the
        // ONLY way that happens is if B cancelled A on start (its fetches
        // reject on abort). With the buggy `activeKey !== key` guard A is never
        // cancelled and stays hung on the gate, so it never settles. Bound the
        // wait so the buggy behaviour fails by assertion, not by suite timeout.
        for (let i = 0; i < 20 && !aSettled; i += 1) {
            await new Promise((r) => setTimeout(r, 0));
        }
        expect(aSettled).toBe(true);

        // After the STALE sync (A) finished, B must STILL be the cancellable
        // live sync — A's finish must not have wiped B's controller.
        expect(isSyncing()).toBe(true);

        // And cancel must actually stop B (its hung fetches reject on abort).
        cancelOfflineSync();
        expect(isSyncing()).toBe(false);
        // Unblock so any straggler fetch promises settle, then drain.
        release();
        await a;
        await Promise.race([b, new Promise((r) => setTimeout(r, 500))]);
    });
});

describe('syncTarget download — streaming backend (Android fs)', () => {
    // Build a store whose active backend streams URLs to storage (the Android
    // filesystem backend's shape) instead of taking an in-heap Blob.
    const makeStreamingStore = () => {
        const db = {
            mediaBlobs: new TableShim<CachedMediaBlob>('Key', MEDIA_BLOBS_MULTI_ENTRY),
            offlineTargets: new TableShim<OfflineTargetRow>('Key'),
        } as unknown as LibraryCacheDb;
        const storeFromUrl = vi.fn(async (_ns: string, key: string) => ({
            ref: { kind: 'fs', path: `/vol/${key}`, volumeId: 'V' },
            size: 1000,
        }));
        const backend = {
            health: async () => ({ available: true }),
            id: 'capacitor-fs',
            load: async () => undefined,
            remove: async () => {},
            resolveUrl: () => undefined,
            store: async (_ns: string, key: string) => ({
                kind: 'fs',
                path: `/vol/${key}`,
                volumeId: 'V',
            }),
            storeFromUrl,
        };
        const store = new LocalMediaStore(
            () => db,
            () => backend as any,
        );
        return { store, storeFromUrl };
    };

    it('streams every song to storage without ever fetching a Blob', async () => {
        controller.getAlbumDetail.mockResolvedValue({
            songs: [song('s1'), song('s2'), song('s3')],
        });
        const { store, storeFromUrl } = makeStreamingStore();
        await store.putTarget(target());

        const result = await syncTarget({ store, target: target() });

        expect(result.Status).toBe('complete');
        expect(await store.count()).toBe(3);
        expect(await store.totalBytes()).toBe(3000);
        // Native streaming was used per song; the in-heap fetch path never ran.
        expect(storeFromUrl).toHaveBeenCalledTimes(3);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(controller.getStreamUrl).toHaveBeenCalledTimes(3);
    });

    it('dedups already-downloaded songs — no re-stream, no network', async () => {
        controller.getAlbumDetail.mockResolvedValue({ songs: [song('s1'), song('s2')] });
        const { store, storeFromUrl } = makeStreamingStore();
        await store.putTarget(target());
        // Pre-seed s1 as already streamed.
        await store.saveStreamed({
            container: 'mp3',
            entityKey: 'srv:album:e1',
            serverId: 'srv',
            songId: 's1',
            url: 'https://srv/dl/s1',
        });
        storeFromUrl.mockClear();

        await syncTarget({ store, target: target() });

        // Only s2 streamed this run.
        expect(storeFromUrl).toHaveBeenCalledTimes(1);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(await store.count()).toBe(2);
    });

    it('enforces the byte cap on the streaming path', async () => {
        mocks.settingsState.localCache.offlineMedia.maxBytes = 2500;
        controller.getAlbumDetail.mockResolvedValue({
            songs: [song('s1'), song('s2'), song('s3')],
        });
        const { store } = makeStreamingStore();
        await store.putTarget(target());

        const result = await syncTarget({ store, target: target() });

        expect(result.Status).toBe('partial');
        expect(await store.count()).toBe(2);
        expect(await store.totalBytes()).toBe(2000);
    });
});
