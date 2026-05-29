/**
 * Regression coverage for the perf rewrite that moved the waveform's cursor
 * updates onto a direct `useTimestampStoreBase.subscribe` channel. The whole
 * point of the rewrite was that a ~250ms timestamp tick should NOT cause a
 * React commit on this component — only the waveform body itself (new song,
 * new wavesurfer instance, drag-state flip) should trigger one.
 */
import type { ReactNode } from 'react';

import { act, cleanup, render } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted: factories below reference these.
const { mockGetDuration, mockLoad, mockOn, mockPause, mockSeekTo, mockSetVolume, mockUn } =
    vi.hoisted(() => ({
        mockGetDuration: vi.fn(() => 200),
        mockLoad: vi.fn(),
        mockOn: vi.fn(),
        mockPause: vi.fn(),
        mockSeekTo: vi.fn(),
        mockSetVolume: vi.fn(),
        mockUn: vi.fn(),
    }));

const fakeWavesurfer = {
    getCurrentTime: vi.fn(() => 0),
    getDuration: mockGetDuration,
    getMediaElement: () => ({ muted: false, volume: 1 }),
    load: mockLoad,
    on: mockOn,
    pause: mockPause,
    seekTo: mockSeekTo,
    setVolume: mockSetVolume,
    un: mockUn,
};

vi.mock('@wavesurfer/react', () => ({
    useWavesurfer: () => ({ wavesurfer: fakeWavesurfer }),
}));

vi.mock('/@/renderer/features/player/audio-player/hooks/use-stream-url', () => ({
    useSongUrl: () => 'http://example.test/song.mp3',
}));

vi.mock('/@/renderer/features/player/context/player-context', () => ({
    usePlayer: () => ({ mediaSeekToTimestamp: vi.fn() }),
}));

vi.mock('/@/renderer/themes/use-app-theme', () => ({
    useAppThemeColors: () => ({ color: { '--theme-colors-primary': 'rgb(0, 0, 0)' } }),
    useColorScheme: () => 'dark',
}));

// Keep motion/AnimatePresence as plain div passthroughs — we don't care about
// animations and they'd otherwise schedule rAF callbacks that pollute the
// render count.
vi.mock('motion/react', () => ({
    AnimatePresence: ({ children }: { children: ReactNode }) => <>{children}</>,
    motion: new Proxy(
        {},
        {
            get:
                () =>
                ({ children, ...props }: Record<string, unknown> & { children?: ReactNode }) => (
                    <div {...props}>{children}</div>
                ),
        },
    ),
}));

vi.mock('/@/renderer/features/player/components/playerbar-slider', () => ({
    CustomPlayerbarSlider: () => <div data-testid="custom-slider" />,
}));
vi.mock('/@/renderer/features/player/components/playerbar-seek-slider', () => ({
    PlayerbarSeekSlider: () => <div data-testid="seek-slider" />,
}));
vi.mock('/@/shared/components/text/text', () => ({
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));

// Inline song state controllable from the test body.
const songRef: {
    current: null | {
        _serverId?: string;
        duration?: number;
        id?: string;
        userFavorite?: boolean;
        userRating?: number;
    };
} = { current: null };

vi.mock('/@/renderer/store', async () => {
    const actual = await vi.importActual<typeof import('/@/renderer/store')>('/@/renderer/store');
    return {
        ...actual,
        usePlaybackSettings: () => ({ transcode: { enabled: false } }),
        usePlayerbarSlider: () => ({
            barAlign: 'top',
            barGap: 2,
            barRadius: 2,
            barWidth: 2,
            loadingDelay: 0,
            stretched: false,
        }),
        usePlayerSong: () => songRef.current as never,
    };
});

// Imported after mocks are registered.
import { PlayerbarWaveform } from '/@/renderer/features/player/components/playerbar-waveform';
import { useTimestampStoreBase } from '/@/renderer/store/timestamp.store';

const renderWithProbe = () => {
    const onRender = vi.fn();
    const utils = render(
        <Profiler id="waveform" onRender={onRender}>
            <PlayerbarWaveform />
        </Profiler>,
    );
    return { ...utils, onRender };
};

afterEach(() => {
    cleanup();
    mockSeekTo.mockClear();
    mockOn.mockClear();
    mockUn.mockClear();
    mockLoad.mockClear();
    songRef.current = null;
    act(() => {
        useTimestampStoreBase.setState({ timestamp: 0 });
    });
});

describe('PlayerbarWaveform render gating', () => {
    it('does NOT commit React when only the timestamp store ticks', async () => {
        songRef.current = {
            _serverId: 'srv1',
            duration: 200_000,
            id: 'song-a',
            userFavorite: false,
            userRating: 0,
        };

        const { onRender } = renderWithProbe();

        const commitsAfterMount = onRender.mock.calls.length;
        expect(commitsAfterMount).toBeGreaterThan(0);

        // Fire 20 timestamp updates back-to-back, like an active player tick.
        for (let t = 1; t <= 20; t++) {
            act(() => {
                useTimestampStoreBase.setState({ timestamp: t });
            });
        }

        // No additional React commits past mount — the cursor moved imperatively
        // via wavesurfer.seekTo, not via a state-driven re-render.
        expect(onRender.mock.calls.length).toBe(commitsAfterMount);

        // The cursor actually moved each tick (one seekTo per tick, plus any
        // applied once on subscribe). Sanity-check that the perf rewrite still
        // drives the visual.
        expect(mockSeekTo.mock.calls.length).toBeGreaterThanOrEqual(20);
    });

    it('still re-renders when the song id changes', async () => {
        songRef.current = {
            _serverId: 'srv1',
            duration: 200_000,
            id: 'song-a',
            userFavorite: false,
        };

        const { onRender, rerender } = renderWithProbe();

        const commitsAfterMount = onRender.mock.calls.length;

        songRef.current = {
            _serverId: 'srv1',
            duration: 180_000,
            id: 'song-b',
            userFavorite: false,
        };

        rerender(
            <Profiler id="waveform" onRender={onRender}>
                <PlayerbarWaveform />
            </Profiler>,
        );

        expect(onRender.mock.calls.length).toBeGreaterThan(commitsAfterMount);
    });
});
