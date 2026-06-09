// Regression test for the scrobble manual-handler registration churn.
//
// The registerScrobbleManualHandlers effect used to depend on playbackRate
// (and other frequently-changing values), so every speed change tore down and
// re-installed the global singleton. React runs ALL effect cleanups before ALL
// effect creations in a passive-effect flush, so any effect that fires between
// the teardown and the re-registration (e.g. a remote-command handler reacting
// to the same state change) hits a null handler and silently no-ops.

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    invokeScrobbleForceSubmit,
    useScrobble,
} from '/@/renderer/features/player/hooks/use-scrobble';
import { usePlayerSpeed, usePlayerStoreBase, useSettingsStore } from '/@/renderer/store';
import { QueueSong } from '/@/shared/types/domain-types';
import { PlayerShuffle } from '/@/shared/types/types';

const { mutateSpy } = vi.hoisted(() => ({ mutateSpy: vi.fn() }));

vi.mock('/@/renderer/features/player/mutations/scrobble-mutation', () => ({
    useSendScrobble: () => ({ mutate: mutateSpy }),
}));

vi.mock('/@/renderer/components/item-image/item-image', () => ({
    useItemImageUrl: () => 'http://localhost/img',
}));

const song = {
    _itemType: 'song',
    _serverId: 'srv',
    _serverType: 'jellyfin',
    _uniqueId: 'u0',
    albumId: 'al0',
    duration: 200,
    id: 's0',
    itemType: 'song',
    name: 's0',
} as unknown as QueueSong;

// First in tree order, so its effect runs BEFORE useScrobble's re-registration
// within the same passive-effect flush.
const SpeedReactor = () => {
    const speed = usePlayerSpeed();
    useEffect(() => {
        if (speed !== 1) {
            invokeScrobbleForceSubmit();
        }
    }, [speed]);
    return null;
};

const ScrobbleHost = () => {
    useScrobble();
    return null;
};

beforeEach(() => {
    mutateSpy.mockClear();
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: 0, shuffle: PlayerShuffle.NONE, speed: 1 },
        queue: {
            ...s.queue,
            default: ['u0'],
            shuffled: [],
            songs: { u0: song },
        },
    }));
    useSettingsStore.setState((s) => ({
        ...s,
        playback: {
            ...s.playback,
            scrobble: { ...s.playback.scrobble, enabled: true },
        },
    }));
});

afterEach(() => {
    usePlayerStoreBase.getState().clearQueue();
    usePlayerStoreBase.setState((s) => ({
        ...s,
        player: { ...s.player, index: -1, speed: 1 },
    }));
});

describe('scrobble manual handler registration', () => {
    it('force-submit invoked while playbackRate changes still submits a scrobble', () => {
        render(
            <>
                <SpeedReactor />
                <ScrobbleHost />
            </>,
        );

        act(() => {
            usePlayerStoreBase.getState().setSpeed(1.5);
        });

        expect(mutateSpy).toHaveBeenCalledTimes(1);
        expect(mutateSpy.mock.calls[0][0].query.playbackRate).toBe(1.5);
    });
});
