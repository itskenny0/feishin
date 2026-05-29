import type { QueueData, QueueSong } from '/@/shared/types/domain-types';

import { describe, expect, it } from 'vitest';

import { cleanQueueForPersistence, mergeOverridingColumns } from './utils';

const makeSong = (id: string): QueueSong =>
    ({
        _uniqueId: id,
        id,
        itemType: 'song',
        name: `Track ${id}`,
    }) as unknown as QueueSong;

describe('cleanQueueForPersistence', () => {
    it('drops songs that are not referenced by the default order', () => {
        const queue: QueueData = {
            default: ['a', 'b'],
            shuffled: [],
            songs: {
                a: makeSong('a'),
                b: makeSong('b'),
                orphan: makeSong('orphan'),
            },
        };

        const cleaned = cleanQueueForPersistence(queue);

        expect(Object.keys(cleaned.songs).sort()).toEqual(['a', 'b']);
        expect(cleaned.songs).not.toHaveProperty('orphan');
    });

    it('preserves the default order and shuffled arrays', () => {
        const queue: QueueData = {
            default: ['a', 'b'],
            shuffled: [1, 0],
            songs: { a: makeSong('a'), b: makeSong('b') },
        };

        const cleaned = cleanQueueForPersistence(queue);

        expect(cleaned.default).toEqual(['a', 'b']);
        expect(cleaned.shuffled).toEqual([1, 0]);
    });

    it('returns an empty songs map when the default order is empty', () => {
        const queue: QueueData = {
            default: [],
            shuffled: [],
            songs: { a: makeSong('a') },
        };

        const cleaned = cleanQueueForPersistence(queue);

        expect(cleaned.songs).toEqual({});
    });

    it('does not mutate the original queue', () => {
        const queue: QueueData = {
            default: ['a'],
            shuffled: [],
            songs: { a: makeSong('a'), orphan: makeSong('orphan') },
        };

        cleanQueueForPersistence(queue);

        expect(Object.keys(queue.songs).sort()).toEqual(['a', 'orphan']);
    });

    it('tolerates a missing default array and songs map', () => {
        const cleaned = cleanQueueForPersistence({} as QueueData);
        expect(cleaned.songs).toEqual({});
    });
});

describe('mergeOverridingColumns', () => {
    it('replaces the columns array with the persisted value', () => {
        const current = { columns: ['default-a', 'default-b'], theme: 'dark' };
        const persisted = { columns: ['user-x'] };

        const result = mergeOverridingColumns(persisted, current);

        expect(result.columns).toEqual(['user-x']);
    });

    it('deep-merges non-columns keys', () => {
        const current = { nested: { keep: 1 }, theme: 'dark' };
        const persisted = { nested: { add: 2 } };

        const result = mergeOverridingColumns(persisted, current) as unknown as {
            nested: { add: number; keep: number };
        };

        expect(result.nested).toEqual({ add: 2, keep: 1 });
    });
});
