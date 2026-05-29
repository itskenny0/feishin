import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    useActivePlayerSource,
    useActiveRepeat,
    useActiveShuffle,
    useRemoteInterpolatedPositionMs,
    useTransportEnabled,
} from '/@/renderer/features/jellyfin-remote-target/hooks/use-active-player-source';
import { useRemoteTargetStore } from '/@/renderer/features/jellyfin-remote-target/store/remote-target-store';
import { Song } from '/@/shared/types/domain-types';
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

// A minimal Song stand-in — only `id` and `duration` are read by these hooks.
const song = (id: string, durationMs: number): Song =>
    ({ duration: durationMs, id }) as unknown as Song;

describe('useRemoteInterpolatedPositionMs (G1: throttled rAF interpolation)', () => {
    // Drive requestAnimationFrame manually so we can count how often the hook
    // writes React state per animation frame, independent of wall-clock rAF.
    let rafCbs: FrameRequestCallback[] = [];
    let rafId = 0;
    let nowMs = 0;

    const flushFrame = () => {
        const cbs = rafCbs;
        rafCbs = [];
        for (const cb of cbs) cb(nowMs);
    };

    afterEach(() => {
        vi.restoreAllMocks();
        rafCbs = [];
        rafId = 0;
        nowMs = 0;
    });

    const installFakeRaf = () => {
        rafCbs = [];
        rafId = 0;
        nowMs = 1_000;
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb) => {
            rafCbs.push(cb);
            return ++rafId;
        });
        vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
        vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    };

    it('returns 0 in local mode (no target)', () => {
        installFakeRaf();
        let result!: { current: number };
        act(() => {
            ({ result } = renderHook(() => useRemoteInterpolatedPositionMs()));
        });
        expect(result.current).toBe(0);
    });

    it('gates React state writes to ~20fps instead of one per rAF frame', () => {
        installFakeRaf();
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        // Playing track sampled "now": positionMs advances with wall clock.
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                nowPlayingItem: song('track-1', 300_000),
                playState: { isPaused: false, positionMs: 0, positionSampledAt: nowMs },
            });
        });

        let renders = 0;
        let result!: { current: number };
        act(() => {
            ({ result } = renderHook(() => {
                renders += 1;
                return useRemoteInterpolatedPositionMs();
            }));
        });

        const rendersAfterMount = renders;
        // Advance ~200ms in 16ms (~60fps) animation frames. Without the
        // throttle this is ~12 setState calls; gated to >=50ms it is <=4.
        for (let i = 0; i < 12; i += 1) {
            nowMs += 16;
            act(() => {
                flushFrame();
            });
        }
        const emittedRenders = renders - rendersAfterMount;
        // 200ms / 50ms cadence => at most ~4 emits (allow +1 for boundary).
        expect(emittedRenders).toBeLessThanOrEqual(5);
        expect(emittedRenders).toBeGreaterThan(0);
        // The position still advances over the window.
        expect(result.current).toBeGreaterThan(100);
    });

    it('resets to 0 when the remote target is cleared', () => {
        installFakeRaf();
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                nowPlayingItem: song('track-1', 300_000),
                playState: { isPaused: false, positionMs: 5_000, positionSampledAt: nowMs },
            });
        });
        let result!: { current: number };
        act(() => {
            ({ result } = renderHook(() => useRemoteInterpolatedPositionMs()));
        });
        nowMs += 100;
        act(() => {
            flushFrame();
        });
        expect(result.current).toBeGreaterThanOrEqual(5_000);

        act(() => {
            useRemoteTargetStore.getState().actions.clearTarget();
        });
        expect(result.current).toBe(0);
    });
});

describe('useActivePlayerSource (G4: slice-narrowed selector)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('keeps a stable object reference across an identical mirror frame', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: ['SetVolume'],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        const np = song('track-1', 300_000);
        const frame = {
            nowPlayingItem: np,
            playState: { isPaused: true, positionMs: 1_000, positionSampledAt: 10_000 },
        } as const;
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({ ...frame });
        });

        let renders = 0;
        let result!: { current: ReturnType<typeof useActivePlayerSource> };
        act(() => {
            ({ result } = renderHook(() => {
                renders += 1;
                return useActivePlayerSource();
            }));
        });
        const first = result.current;
        const rendersAfterMount = renders;
        expect(first.mode).toBe('remote');
        expect(first.nowPlayingItem?.id).toBe('track-1');

        // A second, value-identical poll frame (new mirrored object reference,
        // same field values). With the shallow-narrowed selector the surfaced
        // leaves compare equal, so neither the selector nor the memo fire.
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({ ...frame });
        });
        expect(renders).toBe(rendersAfterMount);
        expect(result.current).toBe(first);
    });

    it('re-renders and updates when a surfaced field changes', () => {
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: [],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                nowPlayingItem: song('track-1', 300_000),
                playState: { isPaused: true, positionMs: 0, positionSampledAt: 10_000 },
            });
        });
        let result!: { current: ReturnType<typeof useActivePlayerSource> };
        act(() => {
            ({ result } = renderHook(() => useActivePlayerSource()));
        });
        expect(result.current.isPaused).toBe(true);

        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                playState: { isPaused: false },
            });
        });
        expect(result.current.isPaused).toBe(false);
    });
});
