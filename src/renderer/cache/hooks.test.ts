import type { LibraryCacheDb } from '/@/renderer/cache/db';
import type { QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { cachedSwr, readEntityCountFallback, snapshotSwr } from '/@/renderer/cache/hooks';
import { readSnapshot, writeSnapshot } from '/@/renderer/cache/snapshot';
import { useCacheStore } from '/@/renderer/cache/store';

const makeCtx = (queryKey: QueryKey): QueryFunctionContext =>
    ({ queryKey, signal: new AbortController().signal }) as unknown as QueryFunctionContext;

// Force the cache subsystem to look "available" with an open DB handle so
// cachedSwr takes the fromCache path. The handle is only forwarded to the
// fromCache callback, which ignores it here.
const FAKE_DB = { table: () => ({}) } as unknown as LibraryCacheDb;
vi.mock('/@/renderer/cache/db', () => ({
    getActiveCacheDb: () => FAKE_DB,
}));

// hooks.ts → sync-first.ts reads the settings store for the sync-first
// policy. Mock it to "local cache disabled" so the SWR behaviour under test
// here (background revalidation enabled) matches the pre-sync-first
// contract; sync-first.test.ts covers the enabled paths.
vi.mock('/@/renderer/store/settings.store', () => ({
    useSettingsStore: {
        getState: () => ({ localCache: { enabled: false } }),
    },
}));

afterEach(() => {
    vi.useRealTimers();
    useCacheStore.setState((s) => ({ ...s, cacheAvailable: undefined }) as never);
});

describe('snapshotSwr', () => {
    it('resolves to null when a cold remote hangs past the timeout', async () => {
        vi.useFakeTimers();
        const queryKey: QueryKey = ['test', 'hang', Math.random()];
        const remote = () => new Promise<unknown>(() => {}); // never settles

        const promise = snapshotSwr({ ctx: makeCtx(queryKey), queryKey, remote });
        await vi.advanceTimersByTimeAsync(8_000);

        await expect(promise).resolves.toBeNull();
    });

    it('returns the snapshot when one exists even if the remote hangs', async () => {
        vi.useFakeTimers();
        const queryKey: QueryKey = ['test', 'snap', Math.random()];
        writeSnapshot(queryKey, { items: [{ id: 'cached' }] });
        const remote = () => new Promise<unknown>(() => {});

        const result = await snapshotSwr({ ctx: makeCtx(queryKey), queryKey, remote });

        expect(result).toEqual({ items: [{ id: 'cached' }] });
    });

    it('returns and snapshots a fast successful response', async () => {
        const queryKey: QueryKey = ['test', 'ok', Math.random()];
        const value = { items: [{ id: 'a' }], totalRecordCount: 1 };
        const remote = async () => value;

        const result = await snapshotSwr({ ctx: makeCtx(queryKey), queryKey, remote });

        expect(result).toEqual(value);
        expect(readSnapshot(queryKey)).toEqual(value);
    });
});

describe('readEntityCountFallback — synchronous count seeding (perf fix #3)', () => {
    it('returns the in-memory store count when no snapshot exists (no DB read)', () => {
        const key: QueryKey = ['srv', 'albums', 'count', Math.random()];
        // No snapshot written for this key.
        useCacheStore.setState((s) => ({
            ...s,
            entityCounts: { ...s.entityCounts, albums: 4242 },
        }));

        const seeded = readEntityCountFallback(key, 'albums');
        expect(seeded).toBe(4242);
    });

    it('prefers a snapshot over the store count when both exist', () => {
        const key: QueryKey = ['srv', 'albums', 'count', Math.random()];
        writeSnapshot(key, 7);
        useCacheStore.setState((s) => ({
            ...s,
            entityCounts: { ...s.entityCounts, albums: 4242 },
        }));

        expect(readEntityCountFallback(key, 'albums')).toBe(7);
    });

    it('returns undefined when neither snapshot nor store has a usable count', () => {
        const key: QueryKey = ['srv', 'albums', 'count', Math.random()];
        useCacheStore.setState((s) => ({
            ...s,
            entityCounts: { ...s.entityCounts, albums: 0 },
        }));
        expect(readEntityCountFallback(key, 'albums')).toBeUndefined();
    });
});

describe('cachedSwr — lock-starvation fallback (perf fix #2)', () => {
    it('awaits the cache read for a known-local key instead of racing to network', async () => {
        vi.useFakeTimers();
        useCacheStore.setState((s) => ({ ...s, cacheAvailable: true }) as never);

        const queryKey: QueryKey = ['test', 'known-local', Math.random()];
        // A prior session served this key from cache → a snapshot exists, so
        // the key is KNOWN to be locally available.
        writeSnapshot(queryKey, { items: [{ id: 'old' }] });

        // fromCache loses the 2s lock race (a sweep write txn holds the lock)
        // but DOES eventually resolve with the cached value.
        const cachedValue = { items: [{ id: 'fresh-from-cache' }] };
        const fromCache = vi.fn(
            () => new Promise<typeof cachedValue>((r) => setTimeout(() => r(cachedValue), 5_000)),
        );
        const remote = vi.fn(async () => ({ items: [{ id: 'from-network' }] }));

        const promise = cachedSwr({ ctx: makeCtx(queryKey), fromCache, queryKey, remote });
        // Advance past the OLD 2s fallback window and let the slow cache read settle.
        await vi.advanceTimersByTimeAsync(6_000);
        const result = await promise;

        // The known-local read wins: the SERVED value is the cache read, not
        // the network. (A background revalidate may still fire — that's the
        // SWR contract — but it never becomes the resolved value here.)
        expect(result).toEqual(cachedValue);
        expect(result).not.toEqual({ items: [{ id: 'from-network' }] });
    });

    it('still falls back to network for a genuinely cold key that times out', async () => {
        vi.useFakeTimers();
        useCacheStore.setState((s) => ({ ...s, cacheAvailable: true }) as never);

        const queryKey: QueryKey = ['test', 'cold-miss', Math.random()];
        // No snapshot → key is NOT known-local. A slow fromCache must not
        // hold the render hostage; the network fallback still applies.
        const fromCache = vi.fn(
            () => new Promise<undefined>((r) => setTimeout(() => r(undefined), 5_000)),
        );
        const networkValue = { items: [{ id: 'from-network' }] };
        const remote = vi.fn(async () => networkValue);

        const promise = cachedSwr({ ctx: makeCtx(queryKey), fromCache, queryKey, remote });
        await vi.advanceTimersByTimeAsync(3_000);
        const result = await promise;

        expect(result).toEqual(networkValue);
        expect(remote).toHaveBeenCalled();
    });
});

describe('cold-timeout late adoption', () => {
    // A slow server response that loses the 8s cold race must still LAND —
    // the page filled in late beats a permanently empty playlist (device,
    // 2026-06-10: a downloaded 100+-track playlist rendered "no items"
    // forever because the late response was discarded).
    it('snapshotSwr adopts a late remote result into snapshot + query cache', async () => {
        vi.useFakeTimers();
        const queryKey: QueryKey = ['test', 'late-snap', Math.random()];
        let resolveRemote: (v: unknown) => void = () => {};
        const remote = () => new Promise<unknown>((r) => (resolveRemote = r));

        const promise = snapshotSwr({ ctx: makeCtx(queryKey), queryKey, remote });
        await vi.advanceTimersByTimeAsync(8_000);
        await expect(promise).resolves.toBeNull(); // timed out cold

        resolveRemote({ items: ['late'] });
        await vi.advanceTimersByTimeAsync(0);

        expect(readSnapshot(queryKey)).toEqual({ items: ['late'] });
    });

    it('cachedSwr adopts a late remote result (apply + snapshot)', async () => {
        vi.useFakeTimers();
        useCacheStore.setState((s) => ({ ...s, cacheAvailable: true }) as never);
        const queryKey: QueryKey = ['test', 'late-cached', Math.random()];
        let resolveRemote: (v: unknown) => void = () => {};
        const remote = () => new Promise<unknown>((r) => (resolveRemote = r));
        const apply = vi.fn(async () => {});

        const promise = cachedSwr({
            apply,
            ctx: makeCtx(queryKey),
            fromCache: async () => undefined,
            queryKey,
            remote,
        });
        await vi.advanceTimersByTimeAsync(8_000);
        await expect(promise).resolves.toBeNull();

        resolveRemote({ items: ['late'] });
        await vi.advanceTimersByTimeAsync(0);
        // Drain the adoption's async apply.
        await vi.advanceTimersByTimeAsync(0);

        expect(apply).toHaveBeenCalledWith(FAKE_DB, { items: ['late'] });
        expect(readSnapshot(queryKey)).toEqual({ items: ['late'] });
    });
});
