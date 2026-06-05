/**
 * Pins the timestamp store's hot-path contract:
 *
 *  The audio engines push the current position ~2-4x/sec while playing, but
 *  rounded to whole seconds. The store action must drop a write when the value
 *  is unchanged (no-op guard) so that identical ticks don't transition the
 *  store, re-run subscribers, or schedule a persisted IndexedDB write.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
    setTimestamp,
    subscribePlayerProgress,
    useTimestampStoreBase,
} from '/@/renderer/store/timestamp.store';

afterEach(() => {
    useTimestampStoreBase.setState({ timestamp: 0 });
});

describe('timestamp store no-op guard', () => {
    it('does not transition or notify when the value is unchanged', () => {
        setTimestamp(12);

        const seen: number[] = [];
        const unsubscribe = subscribePlayerProgress(({ timestamp }) => {
            seen.push(timestamp);
        });

        // Identical value — must be a no-op (no subscriber fire).
        setTimestamp(12);
        setTimestamp(12);
        expect(seen).toEqual([]);

        // A real change fires exactly once.
        setTimestamp(13);
        expect(seen).toEqual([13]);

        // Repeats of the new value are dropped again.
        setTimestamp(13);
        expect(seen).toEqual([13]);

        unsubscribe();
    });
});
