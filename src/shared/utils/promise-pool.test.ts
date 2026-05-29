import { describe, expect, it, vi } from 'vitest';

import { runWithConcurrency } from '/@/shared/utils/promise-pool';

describe('runWithConcurrency', () => {
    it('returns an empty array for an empty input without invoking the worker', async () => {
        const worker = vi.fn();
        const results = await runWithConcurrency([], 4, worker);
        expect(results).toEqual([]);
        expect(worker).not.toHaveBeenCalled();
    });

    it('preserves input order in the results regardless of completion order', async () => {
        const items = [0, 1, 2, 3, 4];
        const results = await runWithConcurrency(items, 2, async (item) => {
            // Earlier items resolve later, so completion order != input order.
            await new Promise((resolve) => setTimeout(resolve, (items.length - item) * 2));
            return item * 10;
        });
        expect(results).toEqual([0, 10, 20, 30, 40]);
    });

    it('passes the correct index to the worker', async () => {
        const indices: number[] = [];
        await runWithConcurrency(['a', 'b', 'c'], 1, async (_item, index) => {
            indices.push(index);
            return index;
        });
        expect(indices).toEqual([0, 1, 2]);
    });

    it('never exceeds the requested concurrency', async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        await runWithConcurrency(
            Array.from({ length: 10 }, (_v, i) => i),
            3,
            async () => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 5));
                inFlight -= 1;
                return null;
            },
        );
        expect(maxInFlight).toBeLessThanOrEqual(3);
        expect(maxInFlight).toBeGreaterThan(1);
    });

    it('clamps non-positive or fractional concurrency to at least 1', async () => {
        const order: number[] = [];
        const results = await runWithConcurrency([1, 2, 3], 0, async (item) => {
            order.push(item);
            return item;
        });
        expect(results).toEqual([1, 2, 3]);
        // With clamped concurrency of 1 the items run strictly in order.
        expect(order).toEqual([1, 2, 3]);
    });

    it('does not start more runners than there are items', async () => {
        let started = 0;
        await runWithConcurrency([1, 2], 8, async (item) => {
            started += 1;
            return item;
        });
        expect(started).toBe(2);
    });

    it('rejects if a worker throws', async () => {
        await expect(
            runWithConcurrency([1, 2, 3], 2, async (item) => {
                if (item === 2) throw new Error('boom');
                return item;
            }),
        ).rejects.toThrow('boom');
    });
});
