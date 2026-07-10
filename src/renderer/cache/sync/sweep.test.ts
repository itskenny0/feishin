// Regression tests for the sweep write loop's lock-yield behaviour
// (perf fix #2). A large page must NOT be written in a single rw
// transaction that holds the IndexedDB write lock for its whole duration —
// that starves interactive cache reads and forces the render path to fall
// back to the network. Instead the page is written in bounded sub-chunks
// with a lock yield between them, and the syncMeta resume marker is written
// last so the checkpoint stays correct.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryCacheDb } from '../db';

import { useCacheStore } from '../store';
import { runSweep, setSweepRetryBaseMsForTests } from './sweep';

// No real retry backoff in tests.
beforeEach(() => setSweepRetryBaseMsForTests(0));

// A Dexie-shim that records transaction boundaries + writePage chunk sizes.
const makeDb = () => {
    const txScopes: unknown[][] = [];
    const syncMeta = {
        get: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
    };
    const entityTable = {
        count: vi.fn(async () => 0),
    };
    const db = {
        albums: entityTable,
        syncMeta,
        table: (_name: string) => entityTable,
        transaction: vi.fn(async (_mode: string, ...rest: unknown[]) => {
            const cb = rest.pop() as () => Promise<void>;
            txScopes.push(rest);
            await cb();
        }),
    } as unknown as LibraryCacheDb;
    return { db, syncMeta, txScopes };
};

afterEach(() => {
    vi.clearAllMocks();
    // Reset the sweep slice of the store so setSweep/setEntityCount don't leak.
    useCacheStore.setState((s) => ({ ...s, sweep: undefined }) as never);
});

describe('runSweep lock-yield', () => {
    it('writes a large page in bounded chunks with a yield between them', async () => {
        const { db, syncMeta, txScopes } = makeDb();
        const total = 500;
        const items = Array.from({ length: total }, (_, i) => ({ id: `a${i}` }));

        const writeSizes: number[] = [];
        const writePage = vi.fn(async (_db: LibraryCacheDb, chunk: unknown[]) => {
            writeSizes.push(chunk.length);
        });

        const ctrl = new AbortController();
        await runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: ctrl.signal },
            fetchPage: async (startIndex) => {
                // single page that returns everything, then a short page to end
                if (startIndex === 0) return { items, total };
                return { items: [], total };
            },
            pageSize: total,
            writePage,
        });

        // 500 rows / 125-row chunks → 4 writePage calls, each <= 125.
        expect(writeSizes.length).toBeGreaterThan(1);
        expect(Math.max(...writeSizes)).toBeLessThanOrEqual(125);
        expect(writeSizes.reduce((a, b) => a + b, 0)).toBe(total);

        // The resume marker was written (syncMeta.put), and at least one
        // row-only transaction did NOT include syncMeta in its scope (i.e.
        // we released the combined lock between chunks). The row chunks open
        // transactions scoped to just the entity table.
        expect(syncMeta.put).toHaveBeenCalled();
        // More than one transaction opened (chunked), proving we didn't hold
        // a single lock for the whole 500-row write.
        expect(txScopes.length).toBeGreaterThan(2);
    });

    it('keeps a small page in a single rows+marker transaction', async () => {
        const { db, txScopes } = makeDb();
        const items = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}` }));
        const writePage = vi.fn(async () => undefined);

        const ctrl = new AbortController();
        await runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: ctrl.signal },
            fetchPage: async () => ({ items, total: 10 }),
            pageSize: 500,
            writePage,
        });

        // One page write → exactly one combined transaction for the page.
        // (The final "mark fully hydrated" syncMeta.put is a direct put, not
        // a transaction, so it doesn't add a scope here.)
        expect(txScopes.length).toBe(1);
        expect(writePage).toHaveBeenCalledTimes(1);
    });

    it('does NOT truncate when later pages suppress the total (return total:0)', async () => {
        const { db } = makeDb();
        const written: { id: string }[] = [];
        const writePage = vi.fn(async (_db: LibraryCacheDb, chunk: unknown[]) => {
            written.push(...(chunk as { id: string }[]));
        });

        // Page 1 reports the real total; pages 2-3 suppress it (total:0, the
        // EnableTotalRecordCount=false optimization). The sweep must keep going
        // until the genuinely short last page — NOT exit early because
        // `itemsDone >= 0`.
        const pages = [
            { items: Array.from({ length: 500 }, (_, i) => ({ id: `p0-${i}` })), total: 1200 },
            { items: Array.from({ length: 500 }, (_, i) => ({ id: `p1-${i}` })), total: 0 },
            { items: Array.from({ length: 200 }, (_, i) => ({ id: `p2-${i}` })), total: 0 },
        ];
        let call = 0;

        const ctrl = new AbortController();
        await runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: ctrl.signal },
            fetchPage: async () => pages[call++] ?? { items: [], total: 0 },
            pageSize: 500,
            writePage,
        });

        // All 1200 items across the three pages were written — a suppressed
        // total:0 did not collapse the loop after page 2 (which would write 1000).
        expect(written.length).toBe(1200);
    });
});

describe('runSweep transient-failure retry', () => {
    it('retries a page that fails once (e.g. a 502) and completes', async () => {
        const { db, syncMeta } = makeDb();
        const writePage = vi.fn(async () => undefined);
        let calls = 0;
        const ctrl = new AbortController();
        await runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: ctrl.signal },
            fetchPage: async () => {
                calls += 1;
                if (calls === 1) throw new Error('Failed to get album artist list'); // 502
                return { items: [{ id: 'a0' }], total: 1 };
            },
            pageSize: 500,
            writePage,
        });
        expect(calls).toBe(2); // failed once, retried, succeeded
        // Reached the terminal "full" mark.
        const putCalls = syncMeta.put.mock.calls as unknown as Array<[{ hydrationState?: string }]>;
        const markedFull = putCalls.some(([m]) => m?.hydrationState === 'full');
        expect(markedFull).toBe(true);
    });

    it('preserves the checkpoint (no full mark, resumable) when a page fails every retry', async () => {
        const { db, syncMeta } = makeDb();
        // A prior page committed the resume cursor at 500.
        syncMeta.get = vi.fn(async () => ({ nextStartIndex: 500, totalCount: 2000 }) as never);
        const writePage = vi.fn(async () => undefined);
        let calls = 0;
        const ctrl = new AbortController();
        // Returns (does NOT throw) so hydrate keeps going to other entities.
        await expect(
            runSweep<{ id: string }>({
                ctx: { db, entity: 'albums', signal: ctrl.signal },
                fetchPage: async () => {
                    calls += 1;
                    throw new Error('Failed to get album artist list');
                },
                pageSize: 500,
                writePage,
            }),
        ).resolves.toBeUndefined();
        expect(calls).toBe(3); // 3 bounded attempts
        // Never marked the entity fully hydrated → the runner resumes from 500.
        expect(syncMeta.put).not.toHaveBeenCalled();
    });
});
