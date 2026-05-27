import { describe, expect, it } from 'vitest';

import { computeRemotePlay } from '/@/renderer/features/jellyfin-remote-target/controller/remote-play';
import { Play } from '/@/shared/types/types';

const songs = (...ids: string[]) => ids.map((id) => ({ id }));

describe('computeRemotePlay', () => {
    it('maps Play.NOW to PlayNow with no startIndex when no playSongId', () => {
        expect(computeRemotePlay(songs('a', 'b', 'c'), Play.NOW)).toEqual({
            itemIds: ['a', 'b', 'c'],
            playCommand: 'PlayNow',
            startIndex: undefined,
        });
    });

    it('resolves startIndex from playSongId for PlayNow', () => {
        expect(computeRemotePlay(songs('a', 'b', 'c'), Play.NOW, 'b')).toEqual({
            itemIds: ['a', 'b', 'c'],
            playCommand: 'PlayNow',
            startIndex: 1,
        });
    });

    it('does not set startIndex when playSongId is the first item', () => {
        expect(computeRemotePlay(songs('a', 'b'), Play.NOW, 'a')?.startIndex).toBeUndefined();
    });

    it('maps Play.NEXT and Play.LAST and ignores playSongId for them', () => {
        expect(computeRemotePlay(songs('a'), Play.NEXT, 'a')?.playCommand).toBe('PlayNext');
        expect(computeRemotePlay(songs('a'), Play.LAST)?.playCommand).toBe('PlayLast');
        expect(computeRemotePlay(songs('a'), Play.NEXT, 'a')?.startIndex).toBeUndefined();
    });

    it('returns null for empty songs', () => {
        expect(computeRemotePlay([], Play.NOW)).toBeNull();
    });

    it('returns null for reorder-edge AddToQueueType objects (local-only)', () => {
        expect(computeRemotePlay(songs('a'), { edge: 'top', uniqueId: 'x' } as never)).toBeNull();
    });
});
