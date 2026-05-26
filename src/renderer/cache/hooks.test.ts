import type { QueryFunctionContext, QueryKey } from '@tanstack/react-query';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { snapshotSwr } from '/@/renderer/cache/hooks';
import { readSnapshot, writeSnapshot } from '/@/renderer/cache/snapshot';

const makeCtx = (queryKey: QueryKey): QueryFunctionContext =>
    ({ queryKey, signal: new AbortController().signal }) as unknown as QueryFunctionContext;

afterEach(() => {
    vi.useRealTimers();
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
