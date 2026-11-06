// Headphones unplugged / Bluetooth disconnected on Android must pause playback.
// The native AudioOutput plugin forwards ACTION_AUDIO_BECOMING_NOISY as a
// `becomingNoisy` event; these tests drive that event through the mounted hook
// and assert the player store (which the UI, media notification and peers all
// follow) ends up paused.

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { addListenerMock, listeners, removeMock } = vi.hoisted(() => {
    const listeners: Array<() => void> = [];
    const removeMock = vi.fn(() => Promise.resolve());
    return {
        addListenerMock: vi.fn((_event: string, cb: () => void) => {
            listeners.push(cb);
            return Promise.resolve({ remove: removeMock });
        }),
        listeners,
        removeMock,
    };
});

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'android',
        isNativePlatform: () => true,
    },
    registerPlugin: () => ({ addListener: addListenerMock }),
}));

import { getLastAudioOutputLossAt, pauseForAudioOutputLoss } from './audio-output-loss';
import { PauseOnDeviceDisconnectHook } from './use-pause-on-device-disconnect';

import { usePlayerStoreBase, useSettingsStore } from '/@/renderer/store';
import { PlayerStatus, PlayerType } from '/@/shared/types/types';

const setStatus = (status: PlayerStatus) =>
    usePlayerStoreBase.setState((s) => ({ ...s, player: { ...s.player, status } }));

const setPlaybackType = (type: PlayerType) =>
    useSettingsStore.setState((s) => ({ ...s, playback: { ...s.playback, type } }));

const fireBecomingNoisy = () => {
    for (const cb of listeners) cb();
};

describe('pause on audio output loss (Android becoming-noisy)', () => {
    beforeEach(() => {
        listeners.length = 0;
        vi.clearAllMocks();
        setPlaybackType(PlayerType.WEB);
        setStatus(PlayerStatus.PLAYING);
    });

    afterEach(() => {
        setStatus(PlayerStatus.PAUSED);
    });

    it('subscribes to the native event on mount and pauses when it fires', async () => {
        const view = render(<PauseOnDeviceDisconnectHook />);
        await act(async () => {});
        expect(addListenerMock).toHaveBeenCalledWith('becomingNoisy', expect.any(Function));

        act(() => fireBecomingNoisy());
        expect(usePlayerStoreBase.getState().player.status).toBe(PlayerStatus.PAUSED);

        view.unmount();
        expect(removeMock).toHaveBeenCalled();
    });

    it('does not touch a player that is not playing', () => {
        setStatus(PlayerStatus.STOPPED);
        expect(pauseForAudioOutputLoss('becoming-noisy')).toBe(false);
        expect(usePlayerStoreBase.getState().player.status).toBe(PlayerStatus.STOPPED);
    });

    it('leaves DLNA / Jukebox playback alone (audio is not on this device)', () => {
        setPlaybackType(PlayerType.DLNA);
        expect(pauseForAudioOutputLoss('becoming-noisy')).toBe(false);
        setPlaybackType(PlayerType.JUKEBOX);
        expect(pauseForAudioOutputLoss('becoming-noisy')).toBe(false);
        expect(usePlayerStoreBase.getState().player.status).toBe(PlayerStatus.PLAYING);
    });

    it('records when the output went away even if nothing was playing', () => {
        setStatus(PlayerStatus.PAUSED);
        const before = Date.now();
        pauseForAudioOutputLoss('becoming-noisy');
        expect(getLastAudioOutputLossAt()).toBeGreaterThanOrEqual(before);
    });
});
