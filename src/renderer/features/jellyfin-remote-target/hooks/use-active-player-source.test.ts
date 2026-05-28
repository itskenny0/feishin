import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import {
    useActiveRepeat,
    useActiveShuffle,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { PlayerRepeat, PlayerShuffle } from '/@/shared/types/types';

// jellyfin-web's real SupportedCommands: GeneralCommand types only — note it
// has NO PlayPause/NextTrack/PreviousTrack/Seek (those are Playstate commands).
const JELLYFIN_WEB_CAPS = [
    'VolumeUp',
    'VolumeDown',
    'Mute',
    'Unmute',
    'ToggleMute',
    'SetVolume',
    'SetRepeatMode',
    'SetShuffleQueue',
    'DisplayMessage',
];

const connect = (caps: string[]) => {
    useRemoteTargetStore.getState().actions.setTarget({
        capabilities: caps,
        deviceId: 'dev-1',
        deviceName: 'Living Room',
        sessionId: 'sess-1',
    });
};

afterEach(() => {
    useRemoteTargetStore.getState().actions.clearTarget();
});

describe('useTransportEnabled', () => {
    it('enables everything in local mode (no target)', () => {
        expect(renderHook(() => useTransportEnabled('PlayPause')).result.current).toBe(true);
        expect(renderHook(() => useTransportEnabled('SetVolume')).result.current).toBe(true);
    });

    it('keeps Playstate transport enabled on a media-control target even though those commands are NOT in SupportedCommands (regression: greyed-out buttons)', () => {
        connect(JELLYFIN_WEB_CAPS);
        for (const cmd of ['PlayPause', 'NextTrack', 'PreviousTrack', 'Seek', 'Stop']) {
            expect(renderHook(() => useTransportEnabled(cmd)).result.current).toBe(true);
        }
    });

    it('gates GeneralCommand-backed controls on the advertised SupportedCommands', () => {
        connect(JELLYFIN_WEB_CAPS);
        expect(renderHook(() => useTransportEnabled('SetVolume')).result.current).toBe(true);
        expect(renderHook(() => useTransportEnabled('SetShuffleQueue')).result.current).toBe(true);
        expect(renderHook(() => useTransportEnabled('SetRepeatMode')).result.current).toBe(true);
        // A GeneralCommand the target does not advertise stays disabled.
        expect(renderHook(() => useTransportEnabled('SetMaxStreamingBitrate')).result.current).toBe(
            false,
        );
    });
});

describe('useActiveRepeat / useActiveShuffle', () => {
    it('mirrors the remote repeat mode + shuffle when a target is active', () => {
        connect(JELLYFIN_WEB_CAPS);
        useRemoteTargetStore.getState().actions.patchPlayState({
            repeatMode: 'RepeatAll',
            shuffle: true,
        });
        expect(renderHook(() => useActiveRepeat()).result.current).toBe(PlayerRepeat.ALL);
        expect(renderHook(() => useActiveShuffle()).result.current).toBe(PlayerShuffle.TRACK);
    });

    it('falls back to the local player state in local mode', () => {
        // No target → local values (defaults: NONE).
        expect(renderHook(() => useActiveRepeat()).result.current).toBe(PlayerRepeat.NONE);
        expect(renderHook(() => useActiveShuffle()).result.current).toBe(PlayerShuffle.NONE);
    });
});
