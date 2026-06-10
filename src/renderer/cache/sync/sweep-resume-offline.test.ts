// Regression tests for sweep restart-tolerance + connectivity pause/resume.
//
// (c) Restart tolerance: an app kill mid-sweep leaves a `partial` syncMeta row
//     carrying `nextStartIndex`. On the next launch runSweep MUST resume from
//     that cursor — not redo completed pages, and not skip the un-done tail.
//
// (d) Connectivity pause/resume: while the network-status signal reports
//     offline, the page loop PARKS before issuing a fetch (no network, no
//     failure recording) and resumes from the SAME cursor when connectivity
//     returns. The persisted checkpoint is untouched while parked, so an app
//     kill during a pause still resumes correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LibraryCacheDb } from '../db';

// Controllable connectivity signal (mirrors images-upgrade.test.ts's net mock).
const net = vi.hoisted(() => {
    const listeners = new Set<() => void>();
    return {
        listeners,
        online: true,
        setOnline(v: boolean) {
            this.online = v;
            for (const cb of [...listeners]) cb();
        },
    };
});

vi.mock('/@/renderer/lib/network-status', () => ({
    getIsOnline: () => net.online,
    subscribeIsOnline: (cb: () => void) => {
        net.listeners.add(cb);
        return () => net.listeners.delete(cb);
    },
}));

import { useCacheStore } from '../store';
import { runSweep } from './sweep';

const makeDb = (initialMeta?: Record<string, unknown>) => {
    // Capture every put payload so the assertions can inspect the persisted
    // checkpoints without relying on `mock.calls` element typing.
    const putCalls: Record<string, unknown>[] = [];
    const syncMeta = {
        get: vi.fn(async (): Promise<Record<string, unknown> | undefined> => initialMeta),
        put: vi.fn(async (row: Record<string, unknown>): Promise<void> => {
            putCalls.push(row);
        }),
        putCalls,
    };
    const entityTable = { count: vi.fn(async () => 0) };
    const db = {
        albums: entityTable,
        syncMeta,
        table: () => entityTable,
        transaction: vi.fn(async (_mode: string, ...rest: unknown[]) => {
            const cb = rest.pop() as () => Promise<void>;
            await cb();
        }),
    } as unknown as LibraryCacheDb;
    return { db, syncMeta };
};

beforeEach(() => {
    net.online = true;
    net.listeners.clear();
});

afterEach(() => {
    vi.clearAllMocks();
    useCacheStore.setState((s) => ({ ...s, sweep: undefined }) as never);
});

describe('runSweep resume-from-cursor (c)', () => {
    it('resumes from the persisted nextStartIndex, not from 0', async () => {
        // Prior run got through 1000 of 1500 items before the app was killed.
        const { db } = makeDb({
            EntityType: 'albums',
            hydrationState: 'partial',
            nextStartIndex: 1000,
            totalCount: 1500,
        });

        const fetchedStartIndices: number[] = [];
        await runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: new AbortController().signal },
            fetchPage: async (startIndex, limit) => {
                fetchedStartIndices.push(startIndex);
                const remaining = Math.max(0, 1500 - startIndex);
                const n = Math.min(limit, remaining);
                return {
                    items: Array.from({ length: n }, (_, i) => ({ id: `a${startIndex + i}` })),
                    total: 1500,
                };
            },
            pageSize: 500,
            writePage: async () => undefined,
        });

        // First fetch starts at the resume cursor (1000), NOT 0. Pages already
        // completed (0, 500) are never re-fetched.
        expect(fetchedStartIndices[0]).toBe(1000);
        expect(fetchedStartIndices).not.toContain(0);
        expect(fetchedStartIndices).not.toContain(500);
        // The un-done tail (1000..1500) IS fetched.
        expect(fetchedStartIndices).toContain(1000);
    });

    it('persists nextStartIndex after each page so a fresh kill resumes mid-run', async () => {
        const { db, syncMeta } = makeDb(undefined);
        await runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: new AbortController().signal },
            fetchPage: async (startIndex, limit) => {
                const remaining = Math.max(0, 1000 - startIndex);
                const n = Math.min(limit, remaining);
                return {
                    items: Array.from({ length: n }, (_, i) => ({ id: `a${startIndex + i}` })),
                    total: 1000,
                };
            },
            pageSize: 500,
            writePage: async () => undefined,
        });

        // A partial-checkpoint put with nextStartIndex=500 must have happened
        // BEFORE the final full-hydration put.
        const partialCheckpoints = syncMeta.putCalls.filter((m) => m.hydrationState === 'partial');
        expect(partialCheckpoints.some((m) => m.nextStartIndex === 500)).toBe(true);
        // Final state is full hydration with the resume marker reset to 0.
        const last = syncMeta.putCalls.at(-1)!;
        expect(last.hydrationState).toBe('full');
        expect(last.nextStartIndex).toBe(0);
    });
});

describe('runSweep connectivity pause/resume (d)', () => {
    it('parks while offline and does not fetch until connectivity returns', async () => {
        net.online = false;
        const { db } = makeDb(undefined);

        let fetchCalls = 0;
        const sweepPromise = runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: new AbortController().signal },
            fetchPage: async (startIndex, limit) => {
                fetchCalls += 1;
                const remaining = Math.max(0, 500 - startIndex);
                const n = Math.min(limit, remaining);
                return {
                    items: Array.from({ length: n }, (_, i) => ({ id: `a${startIndex + i}` })),
                    total: 500,
                };
            },
            pageSize: 500,
            writePage: async () => undefined,
        });

        // Give the loop a tick to reach the offline park. No fetch should fire.
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchCalls).toBe(0);

        // Dashboard reflects paused (offline) while parked.
        const parked = useCacheStore.getState().sweep;
        expect(parked?.progress.paused).toBe('offline');

        // Connectivity returns → the parked loop wakes and completes.
        net.setOnline(true);
        await sweepPromise;
        expect(fetchCalls).toBeGreaterThan(0);
        // Resume cleared the paused flag (sweep ends with setSweep(undefined)).
        expect(useCacheStore.getState().sweep).toBeUndefined();
    });

    it('resumes from the same cursor after an offline blip mid-sweep', async () => {
        const { db } = makeDb(undefined);
        const fetchedStartIndices: number[] = [];

        const sweepPromise = runSweep<{ id: string }>({
            ctx: { db, entity: 'albums', signal: new AbortController().signal },
            fetchPage: async (startIndex, limit) => {
                fetchedStartIndices.push(startIndex);
                // Drop the link right after the first page so the SECOND page
                // request has to wait for reconnect.
                if (startIndex === 0) net.setOnline(false);
                const remaining = Math.max(0, 1500 - startIndex);
                const n = Math.min(limit, remaining);
                return {
                    items: Array.from({ length: n }, (_, i) => ({ id: `a${startIndex + i}` })),
                    total: 1500,
                };
            },
            pageSize: 500,
            writePage: async () => undefined,
        });

        // After the first page the loop parks (offline). Only index 0 fetched.
        await new Promise((r) => setTimeout(r, 20));
        expect(fetchedStartIndices).toEqual([0]);

        // Reconnect → resume from 500 (the saved cursor), then 1000.
        net.setOnline(true);
        await sweepPromise;
        expect(fetchedStartIndices).toEqual([0, 500, 1000]);
    });
});
