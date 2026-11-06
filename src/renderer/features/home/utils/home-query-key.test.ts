import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import {
    homeQueryKey,
    invalidatePlayedHomeShelves,
} from '/@/renderer/features/home/utils/home-query-key';

describe('invalidatePlayedHomeShelves', () => {
    it('invalidates the played shelves of the scrobbled server only', async () => {
        const client = new QueryClient();
        const keys = {
            albumMost: homeQueryKey('album', 'mostPlayed', 's1'),
            albumRecent: homeQueryKey('album', 'recentlyPlayed', 's1'),
            otherServer: homeQueryKey('song', 'recentlyPlayed', 's2'),
            recentlyAdded: homeQueryKey('album', 'recentlyAdded', 's1'),
            songMost: homeQueryKey('song', 'mostPlayed', 's1'),
            songRecent: homeQueryKey('song', 'recentlyPlayed', 's1'),
        };
        for (const key of Object.values(keys)) client.setQueryData(key, []);

        await invalidatePlayedHomeShelves(client, 's1');

        const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
        expect(invalidated(keys.albumMost)).toBe(true);
        expect(invalidated(keys.albumRecent)).toBe(true);
        expect(invalidated(keys.songMost)).toBe(true);
        expect(invalidated(keys.songRecent)).toBe(true);
        expect(invalidated(keys.recentlyAdded)).toBe(false);
        expect(invalidated(keys.otherServer)).toBe(false);
    });
});
