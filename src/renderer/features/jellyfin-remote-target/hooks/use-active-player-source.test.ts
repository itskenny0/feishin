import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    buildRemoteQueueView,
    resolveRemoteNextItem,
    useActiveNextItem,
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

    it('keeps a stable object reference when only positionMs advances', () => {
        // Position is intentionally excluded from the shallow selection, so a
        // poll frame that only advances playState.positionMs must NOT churn the
        // source object identity (consumers read live position from
        // useRemoteInterpolatedPositionMs instead).
        vi.spyOn(Date, 'now').mockReturnValue(10_000);
        useRemoteTargetStore.getState().actions.setTarget({
            capabilities: ['SetVolume'],
            deviceId: 'dev-1',
            deviceName: 'Living Room',
            sessionId: 'sess-1',
        });
        const np = song('track-1', 300_000);
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                nowPlayingItem: np,
                playState: { isPaused: false, positionMs: 1_000, positionSampledAt: 10_000 },
            });
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
        expect(first.positionMs).toBe(0);

        // Next poll: position has advanced, nothing else changed.
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                playState: { isPaused: false, positionMs: 42_000, positionSampledAt: 11_000 },
            });
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

// BUG 1: the controller must derive "next" from the target-reported `nxt`
// (mirrored as nextItemId), NOT the default-order queue, so shuffle on the
// target shows the right upcoming track. Reuses the file's `song(id, durMs)`
// helper.
describe('resolveRemoteNextItem (BUG 1)', () => {
    it('prefers the target-reported nextItemId over the default-order neighbour', () => {
        const queue = [song('a', 0), song('b', 0), song('c', 0), song('d', 0)];
        // Default-order next would be 'b' (index 1), but the shuffling target
        // says it will actually play 'd' next.
        const next = resolveRemoteNextItem({ nextItemId: 'd', queue, queueIndex: 0 });
        expect(next?.id).toBe('d');
    });

    it('returns a bare id-shape when nextItemId is not in the mirrored queue', () => {
        const next = resolveRemoteNextItem({
            nextItemId: 'not-hydrated',
            queue: [song('a', 0)],
            queueIndex: 0,
        });
        expect(next?.id).toBe('not-hydrated');
    });

    it('falls back to default-order queue[queueIndex + 1] when nextItemId is null', () => {
        const queue = [song('a', 0), song('b', 0), song('c', 0)];
        const next = resolveRemoteNextItem({ nextItemId: null, queue, queueIndex: 0 });
        expect(next?.id).toBe('b');
    });

    it('returns null at the end of the queue with no nextItemId', () => {
        const queue = [song('a', 0), song('b', 0)];
        expect(resolveRemoteNextItem({ nextItemId: null, queue, queueIndex: 1 })).toBeNull();
    });

    it('returns null when the queue / index is unknown and no nextItemId', () => {
        expect(resolveRemoteNextItem({ nextItemId: null, queue: [], queueIndex: -1 })).toBeNull();
    });
});

describe('buildRemoteQueueView (shuffle up-next)', () => {
    it('returns the default-order queue unchanged when no upcoming list is present', () => {
        const queue = [song('a', 0), song('b', 0), song('c', 0)];
        const view = buildRemoteQueueView({ queue, queueIndex: 0, upcomingItemIds: [] });
        expect(view.map((s) => s.id)).toEqual(['a', 'b', 'c']);
        // Same array reference — no needless allocation in the common (non-shuffle) path.
        expect(view).toBe(queue);
    });

    it('reorders into [current, ...upcoming, ...rest] under shuffle', () => {
        // Default-order queue a,b,c,d. Current is 'c' (index 2). Target shuffles
        // and reports it will play d, then a, next.
        const queue = [song('a', 0), song('b', 0), song('c', 0), song('d', 0)];
        const view = buildRemoteQueueView({
            queue,
            queueIndex: 2,
            upcomingItemIds: ['d', 'a'],
        });
        // current 'c' first, then true upcoming 'd','a', then leftover 'b'.
        expect(view.map((s) => s.id)).toEqual(['c', 'd', 'a', 'b']);
    });

    it('keeps the whole queue reachable (every item shown exactly once)', () => {
        const queue = [song('a', 0), song('b', 0), song('c', 0), song('d', 0)];
        const view = buildRemoteQueueView({
            queue,
            queueIndex: 1,
            upcomingItemIds: ['d'],
        });
        expect(view.map((s) => s.id).sort()).toEqual(['a', 'b', 'c', 'd']);
        // No duplicates.
        expect(new Set(view.map((s) => s.id)).size).toBe(view.length);
    });

    it('drops upcoming ids not present in the mirrored queue (not yet hydrated)', () => {
        const queue = [song('a', 0), song('b', 0)];
        const view = buildRemoteQueueView({
            queue,
            queueIndex: 0,
            upcomingItemIds: ['zzz', 'b'],
        });
        // 'zzz' isn't in the queue → skipped; 'b' surfaces right after current.
        expect(view.map((s) => s.id)).toEqual(['a', 'b']);
    });

    it('returns the rows as the same Song references from the queue (stable identity)', () => {
        const a = song('a', 0);
        const b = song('b', 0);
        const queue = [a, b];
        const view = buildRemoteQueueView({ queue, queueIndex: 0, upcomingItemIds: ['b'] });
        expect(view[0]).toBe(a);
        expect(view[1]).toBe(b);
    });

    it('returns [] for an empty queue', () => {
        expect(buildRemoteQueueView({ queue: [], queueIndex: -1, upcomingItemIds: ['a'] })).toEqual(
            [],
        );
    });

    it('omits the current track from the leftover tail even when queueIndex is unknown', () => {
        // queueIndex -1 (unknown). Upcoming drives the order; every queue item
        // still appears once.
        const queue = [song('a', 0), song('b', 0), song('c', 0)];
        const view = buildRemoteQueueView({
            queue,
            queueIndex: -1,
            upcomingItemIds: ['c', 'a'],
        });
        expect(view.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    });
});

describe('useActiveNextItem (BUG 1)', () => {
    it('is null in local mode (no target)', () => {
        expect(renderHook(() => useActiveNextItem()).result.current).toBeNull();
    });

    it('surfaces the target-reported next track under shuffle', () => {
        connect([]);
        act(() => {
            useRemoteTargetStore.getState().actions.applyMirrorFromServer({
                nextItemId: 'd',
                nowPlayingItem: song('a', 0),
                queue: [song('a', 0), song('b', 0), song('c', 0), song('d', 0)],
                queueIndex: 0,
            });
        });
        let result!: { current: ReturnType<typeof useActiveNextItem> };
        act(() => {
            ({ result } = renderHook(() => useActiveNextItem()));
        });
        expect(result.current?.id).toBe('d');
    });
});
