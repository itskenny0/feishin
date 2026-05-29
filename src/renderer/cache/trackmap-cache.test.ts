// Unit tests for the Dexie-backed trackmap analysis cache.
//
// Following the same approach as media-store.test.ts / search.test.ts: rather
// than spin up a real IndexedDB (the repo's test setup has no fake-indexeddb),
// we drive the module against an in-memory Dexie-table shim that implements
// only the surface the module touches (get/put/update/clear, orderBy(...).keys,
// orderBy(...).until(...).each, bulkDelete). The active-DB accessor and the
// platform probe are mocked so we can exercise both the opt-in gate and the
// quota-capped eviction path.

import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { CachedTrackmap } from '/@/renderer/cache/types';

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    activeDb: { current: undefined as LibraryCacheDb | undefined },
    isElectron: { current: false },
}));

vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => mocks.activeDb.current,
}));

vi.mock('is-electron', () => ({
    default: () => mocks.isElectron.current,
}));

import {
    clearTrackmaps,
    evictTrackmaps,
    getCachedTrackmap,
    putCachedTrackmap,
    sumTrackmapBytes,
    TRACKMAP_CACHE_CAP_BYTES,
    type TrackmapAnalysis,
} from '/@/renderer/cache/trackmap-cache';

// --- in-memory Dexie trackmaps-table shim -----------------------------

const keyStr = (k: unknown): string => JSON.stringify(k);

class TrackmapsTableShim {
    readonly rows = new Map<string, CachedTrackmap>();

    async bulkDelete(keys: [string, number, number][]): Promise<void> {
        for (const k of keys) this.rows.delete(keyStr(k));
    }

    async clear(): Promise<void> {
        this.rows.clear();
    }

    async count(): Promise<number> {
        return this.rows.size;
    }

    async get(key: [string, number, number]): Promise<CachedTrackmap | undefined> {
        return this.rows.get(keyStr(key));
    }

    orderBy(field: 'ByteSize' | 'LastUsed') {
        const sorted = () =>
            [...this.rows.values()].sort((a, b) => (a[field] as number) - (b[field] as number));
        return {
            each: async (fn: (row: CachedTrackmap) => void): Promise<void> => {
                for (const row of sorted()) fn({ ...row });
            },
            keys: async (): Promise<unknown[]> => sorted().map((r) => r[field]),
            until: (stop: () => boolean) => ({
                each: async (fn: (row: CachedTrackmap) => void): Promise<void> => {
                    for (const row of sorted()) {
                        if (stop()) break;
                        fn({ ...row });
                    }
                },
            }),
        };
    }

    async put(row: CachedTrackmap): Promise<void> {
        this.rows.set(keyStr(this.pk(row)), row);
    }

    async update(key: [string, number, number], changes: Partial<CachedTrackmap>): Promise<void> {
        const existing = this.rows.get(keyStr(key));
        if (existing) this.rows.set(keyStr(key), { ...existing, ...changes });
    }

    private pk(row: CachedTrackmap): [string, number, number] {
        return [row.SongId, row.Sensitivity, row.Version];
    }
}

const makeDb = (): { db: LibraryCacheDb; trackmaps: TrackmapsTableShim } => {
    const trackmaps = new TrackmapsTableShim();
    return { db: { trackmaps } as unknown as LibraryCacheDb, trackmaps };
};

const analysis = (binCount = 256): TrackmapAnalysis => ({
    bins: new Float32Array(binCount).fill(0.5),
    computedAt: Date.now(),
    durationMs: 200_000,
    version: 1,
});

beforeEach(() => {
    mocks.activeDb.current = undefined;
    mocks.isElectron.current = false;
});

describe('trackmap dexie cache', () => {
    it('round-trips a generated analysis (put then get hit)', async () => {
        const { db } = makeDb();
        mocks.activeDb.current = db;

        const data = analysis();
        await putCachedTrackmap('song-1', 3, data);

        const hit = await getCachedTrackmap('song-1', 3, 1);
        expect(hit).toBeDefined();
        expect(hit?.bins).toBeInstanceOf(Float32Array);
        expect(hit?.bins.length).toBe(256);
        expect(hit?.durationMs).toBe(200_000);
        expect(hit?.version).toBe(1);
    });

    it('misses when the sensitivity differs (params invalidation)', async () => {
        const { db } = makeDb();
        mocks.activeDb.current = db;

        await putCachedTrackmap('song-1', 3, analysis());

        expect(await getCachedTrackmap('song-1', 7, 1)).toBeUndefined();
        // The matching sensitivity still hits.
        expect(await getCachedTrackmap('song-1', 3, 1)).toBeDefined();
    });

    it('misses when the version differs (algorithm-version invalidation)', async () => {
        const { db } = makeDb();
        mocks.activeDb.current = db;

        await putCachedTrackmap('song-1', 3, analysis());

        // A future TRACKMAP_DATA_VERSION query does not match the v1 row.
        expect(await getCachedTrackmap('song-1', 3, 2)).toBeUndefined();
    });

    it('is inert when the cache is disabled (no active DB)', async () => {
        // No active DB -> opt-in gate closed.
        mocks.activeDb.current = undefined;

        // put is a silent no-op; get returns undefined.
        await putCachedTrackmap('song-1', 3, analysis());
        expect(await getCachedTrackmap('song-1', 3, 1)).toBeUndefined();
    });

    it('bumps LastUsed on a cache hit', async () => {
        const { db, trackmaps } = makeDb();
        mocks.activeDb.current = db;

        await putCachedTrackmap('song-1', 3, analysis());
        const before = [...trackmaps.rows.values()][0].LastUsed;

        // Advance the clock so the bump is observable.
        const later = before + 5_000;
        vi.spyOn(Date, 'now').mockReturnValue(later);
        await getCachedTrackmap('song-1', 3, 1);
        vi.restoreAllMocks();

        // The fire-and-forget update has resolved by now (awaited internally
        // via the shim's synchronous Map mutation).
        const after = [...trackmaps.rows.values()][0].LastUsed;
        expect(after).toBe(later);
    });

    it('accounts ByteSize via the index sum', async () => {
        const { db } = makeDb();
        mocks.activeDb.current = db;

        await putCachedTrackmap('a', 1, analysis(256)); // 256*4 = 1024 bytes
        await putCachedTrackmap('b', 1, analysis(128)); // 128*4 = 512 bytes

        expect(await sumTrackmapBytes(db)).toBe(1024 + 512);
    });

    it('evicts least-recently-used rows when over the cap (quota-capped)', async () => {
        const { db, trackmaps } = makeDb();
        mocks.activeDb.current = db;
        mocks.isElectron.current = false; // quota-capped platform

        // Each row is ~60% of the cap, so two rows (120%) exceed it but
        // dropping the single oldest row (leaving 60%) restores the cap. This
        // proves the LRU pass evicts oldest-first and stops as soon as it's
        // back under cap (it must NOT keep going and drop the hot 'new' row).
        const binsPerRow = Math.ceil((TRACKMAP_CACHE_CAP_BYTES * 0.6) / 4);
        const big = (): TrackmapAnalysis => ({
            bins: new Float32Array(binsPerRow).fill(0.1),
            computedAt: Date.now(),
            durationMs: 1000,
            version: 1,
        });

        // Oldest first.
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        await putCachedTrackmap('old', 1, big());
        vi.spyOn(Date, 'now').mockReturnValue(2_000);
        await putCachedTrackmap('new', 1, big());
        vi.restoreAllMocks();

        await evictTrackmaps();

        const remaining = [...trackmaps.rows.values()].map((r) => r.SongId);
        // The oldest ('old') must be evicted; the most-recent ('new') kept.
        expect(remaining).not.toContain('old');
        expect(remaining).toContain('new');
        expect(await sumTrackmapBytes(db)).toBeLessThanOrEqual(TRACKMAP_CACHE_CAP_BYTES);
    });

    it('never evicts on Electron (uncapped)', async () => {
        const { db, trackmaps } = makeDb();
        mocks.activeDb.current = db;
        mocks.isElectron.current = true;

        const overCapBins = TRACKMAP_CACHE_CAP_BYTES / 4 + 1024;
        const big = (): TrackmapAnalysis => ({
            bins: new Float32Array(overCapBins).fill(0.1),
            computedAt: Date.now(),
            durationMs: 1000,
            version: 1,
        });

        await putCachedTrackmap('a', 1, big());
        await putCachedTrackmap('b', 1, big());

        await evictTrackmaps();

        expect(trackmaps.rows.size).toBe(2);
    });

    it('clears the whole table', async () => {
        const { db, trackmaps } = makeDb();
        mocks.activeDb.current = db;

        await putCachedTrackmap('a', 1, analysis());
        await putCachedTrackmap('b', 2, analysis());
        expect(trackmaps.rows.size).toBe(2);

        await clearTrackmaps();
        expect(trackmaps.rows.size).toBe(0);
    });
});

describe('trackmap is NOT pre-generated by the library sync sweep', () => {
    // Static-source guard: the requirement is that trackmap analyses are
    // generated lazily on play, never during the sync sweep. Assert no sync
    // module references the trackmap feature / analysis at all, so a future
    // refactor can't quietly wire pre-generation into the sweep.
    it('no cache/sync/* module imports or invokes trackmap analysis', () => {
        const syncDir = join(__dirname, 'sync');
        const files = readdirSync(syncDir).filter((f) => f.endsWith('.ts'));
        expect(files.length).toBeGreaterThan(0);

        const forbidden = /trackmap|analyzeSong|TrackmapWorker/i;
        for (const file of files) {
            const src = readFileSync(join(syncDir, file), 'utf8');
            expect(forbidden.test(src), `${file} must not reference trackmap`).toBe(false);
        }
    });
});
