import { beforeEach, describe, expect, it, vi } from 'vitest';

const actions = {
    mediaNext: vi.fn(),
    mediaPause: vi.fn(),
    mediaPlay: vi.fn(),
    mediaPrevious: vi.fn(),
    mediaSeekToTimestamp: vi.fn(),
    mediaToggleMute: vi.fn(),
    player: { muted: false },
    setRepeat: vi.fn(),
    setShuffle: vi.fn(),
    setVolume: vi.fn(),
};

vi.mock('/@/renderer/store/player.store', () => ({
    usePlayerStoreBase: { getState: () => actions },
}));

import { __setHaDropVolumeForTests, applyHaCommand } from './ha-commands';

import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

describe('applyHaCommand', () => {
    beforeEach(() => {
        for (const v of Object.values(actions)) {
            if (typeof v === 'function') (v as ReturnType<typeof vi.fn>).mockReset();
        }
        __setHaDropVolumeForTests(false);
        actions.player.muted = false;
    });

    it('maps transport verbs', () => {
        applyHaCommand('play', 'PRESS');
        expect(actions.mediaPlay).toHaveBeenCalled();
        applyHaCommand('pause', 'PRESS');
        expect(actions.mediaPause).toHaveBeenCalled();
        applyHaCommand('next', 'PRESS');
        expect(actions.mediaNext).toHaveBeenCalled();
        applyHaCommand('previous', 'PRESS');
        expect(actions.mediaPrevious).toHaveBeenCalled();
    });

    it('stop pauses and seeks to 0', () => {
        applyHaCommand('stop', 'PRESS');
        expect(actions.mediaPause).toHaveBeenCalled();
        expect(actions.mediaSeekToTimestamp).toHaveBeenCalledWith(0);
    });

    it('volume sets the numeric value', () => {
        applyHaCommand('volume', '42');
        expect(actions.setVolume).toHaveBeenCalledWith(42);
    });

    it('drops volume when the Android guard is set', () => {
        __setHaDropVolumeForTests(true);
        applyHaCommand('volume', '42');
        expect(actions.setVolume).not.toHaveBeenCalled();
    });

    it('mute toggles only on a real change', () => {
        applyHaCommand('mute', 'true');
        expect(actions.mediaToggleMute).toHaveBeenCalledTimes(1);
        actions.player.muted = true;
        applyHaCommand('mute', 'true');
        expect(actions.mediaToggleMute).toHaveBeenCalledTimes(1);
    });

    it('shuffle + repeat map onto the store enums', () => {
        applyHaCommand('shuffle', 'true');
        expect(actions.setShuffle).toHaveBeenCalledWith(PlayerShuffle.TRACK);
        applyHaCommand('repeat', 'one');
        expect(actions.setRepeat).toHaveBeenCalledWith(PlayerRepeat.ONE);
    });

    it('seek parses seconds', () => {
        applyHaCommand('seek', '30');
        expect(actions.mediaSeekToTimestamp).toHaveBeenCalledWith(30);
    });

    it('ignores a non-numeric volume/seek', () => {
        applyHaCommand('volume', 'NaNish');
        applyHaCommand('seek', 'xx');
        expect(actions.setVolume).not.toHaveBeenCalled();
        expect(actions.mediaSeekToTimestamp).not.toHaveBeenCalled();
    });
});
