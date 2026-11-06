import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('/@/shared/components/toast/toast', () => ({
    toast: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { dispatchJellyfinMessage } from './message-dispatcher';

import { usePlayerStoreBase } from '/@/renderer/store/player.store';
import { Song } from '/@/shared/types/domain-types';
import { PlayerShuffle } from '/@/shared/types/types';

const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
const song = (id: string) =>
    ({ _serverId: 'srv', duration: 200_000, id, itemType: 'song', name: id }) as unknown as Song;

afterEach(() => {
    vi.restoreAllMocks();
    usePlayerStoreBase.getState().clearQueue();
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: -1, shuffle: PlayerShuffle.NONE },
    }));
});

describe('dispatchJellyfinMessage Play (fresh queue)', () => {
    it.each([PlayerShuffle.NONE, PlayerShuffle.TRACK])(
        'PlayNow with a StartIndex starts on that track first in play order (shuffle %s)',
        async (shuffle) => {
            usePlayerStoreBase.setState((s) => ({ ...s, player: { ...s.player, shuffle } }));
            // Deterministic shuffle that does not happen to put 'd' first.
            vi.spyOn(Math, 'random').mockReturnValue(0);

            await dispatchJellyfinMessage(
                {
                    Data: { ItemIds: ids, PlayCommand: 'PlayNow', StartIndex: 3 },
                    MessageType: 'Play',
                } as never,
                {
                    defaultVolumeStep: 5,
                    fetchSongsByIds: async () => ids.map(song),
                    playerActions: {} as never,
                },
            );

            const state = usePlayerStoreBase.getState();
            expect(state.getCurrentSong()?.id).toBe('d');
            // Under shuffle, nothing shuffled ahead of the requested track may
            // be skipped: it must be the first entry of the play order.
            if (shuffle === PlayerShuffle.TRACK) expect(state.player.index).toBe(0);
            expect(state.getQueue().items).toHaveLength(ids.length);
        },
    );
});
