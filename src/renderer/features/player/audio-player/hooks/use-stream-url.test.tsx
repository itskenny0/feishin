// Playback-substitution tests for useSongUrl.
//
// The offline-media feature substitutes a `blob:` object URL for the remote
// stream URL when a local copy exists — but ONLY on the web-audio engine
// (blob URLs can't play on MPV). These tests mock the LocalMediaStore, the
// API controller, and the playback-type selector, then assert:
//
//   1. A blob URL is returned when a local copy exists and the engine is web.
//   2. The remote URL is returned when no local copy exists.
//   3. The remote URL is returned on the MPV (local) engine even when a local
//      copy exists.
//
// We don't render the real audio engine — renderHook drives the hook directly
// inside a QueryClientProvider so the internal useQuery resolves.

import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PlayerType } from '/@/shared/types/types';

// `PlayerType` can't be referenced inside vi.hoisted (it runs before imports),
// so seed with the underlying string value (PlayerType.WEB === 'web').
const mocks = vi.hoisted(() => ({
    availabilityListeners: new Set<() => void>(),
    getStreamUrl: vi.fn(),
    mediaGet: vi.fn(),
    playbackType: 'web' as string,
    songAvailable: { value: false },
}));

const flipAvailability = (value: boolean) => {
    mocks.songAvailable.value = value;
    mocks.availabilityListeners.forEach((cb) => cb());
};

vi.mock('/@/renderer/api', () => ({
    api: { controller: { getStreamUrl: mocks.getStreamUrl } },
}));

vi.mock('/@/renderer/cache/media-store', () => ({
    localMediaStore: { get: mocks.mediaGet },
}));

vi.mock('/@/renderer/store', () => ({
    usePlaybackType: () => mocks.playbackType,
}));

// Reactive availability signal backed by a controllable external store so a
// test can flip "song became available offline" and assert the hook reacts.
vi.mock('/@/renderer/cache/use-offline-availability', () => ({
    useIsSongOfflineAvailable: () =>
        useSyncExternalStore(
            (cb) => {
                mocks.availabilityListeners.add(cb);
                return () => mocks.availabilityListeners.delete(cb);
            },
            () => mocks.songAvailable.value,
        ),
}));

import { useSongUrl } from '/@/renderer/features/player/audio-player/hooks/use-stream-url';

const SONG = {
    _serverId: 'srv',
    _uniqueId: 'u1',
    container: 'mp3',
    id: 's1',
} as any;

const TRANSCODE = { enabled: false };

const wrapper = ({ children }: { children: ReactNode }) => {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.playbackType = PlayerType.WEB;
    mocks.songAvailable.value = false;
    mocks.getStreamUrl.mockResolvedValue('https://srv/remote/s1');
    // jsdom lacks createObjectURL.
    global.URL.createObjectURL = vi.fn(() => 'blob:fake-object-url');
    global.URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useSongUrl playback substitution', () => {
    it('returns a blob URL when a local copy exists on the web engine', async () => {
        mocks.mediaGet.mockResolvedValue({ Blob: new Blob(['x']), ByteSize: 1, SongId: 's1' });

        const { result } = renderHook(() => useSongUrl(SONG, true, TRANSCODE), { wrapper });

        await waitFor(() => expect(result.current).toBe('blob:fake-object-url'));
        expect(global.URL.createObjectURL).toHaveBeenCalledTimes(1);
        // The remote stream URL must NOT be fetched when serving locally.
        expect(mocks.getStreamUrl).not.toHaveBeenCalled();
    });

    it('returns the remote URL when no local copy exists', async () => {
        mocks.mediaGet.mockResolvedValue(undefined);

        const { result } = renderHook(() => useSongUrl(SONG, true, TRANSCODE), { wrapper });

        await waitFor(() => expect(result.current).toBe('https://srv/remote/s1'));
        expect(mocks.getStreamUrl).toHaveBeenCalledTimes(1);
        expect(global.URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('returns the remote URL on the MPV (local) engine even with a local copy', async () => {
        mocks.playbackType = PlayerType.LOCAL;
        mocks.mediaGet.mockResolvedValue({ Blob: new Blob(['x']), ByteSize: 1, SongId: 's1' });

        const { result } = renderHook(() => useSongUrl(SONG, true, TRANSCODE), { wrapper });

        await waitFor(() => expect(result.current).toBe('https://srv/remote/s1'));
        // No blob URL created on MPV.
        expect(global.URL.createObjectURL).not.toHaveBeenCalled();
        expect(mocks.getStreamUrl).toHaveBeenCalledTimes(1);
    });

    it('re-runs the local lookup when offline availability flips on after mount', async () => {
        // Boot race regression: the first lookup runs BEFORE the offline-media
        // store has loaded its index (get -> undefined), so the hook concludes
        // "no local copy" and serves the remote URL. When the availability
        // index lands (or a download completes), the hook MUST re-check and
        // swap to the blob — otherwise an offline launch plays a dead network
        // URL for the whole session.
        mocks.mediaGet.mockResolvedValue(undefined);

        const { result } = renderHook(() => useSongUrl(SONG, true, TRANSCODE), { wrapper });
        await waitFor(() => expect(result.current).toBe('https://srv/remote/s1'));

        mocks.mediaGet.mockResolvedValue({ Blob: new Blob(['x']), ByteSize: 1, SongId: 's1' });
        flipAvailability(true);

        await waitFor(() => expect(result.current).toBe('blob:fake-object-url'));
    });

    it('revokes the object URL on unmount', async () => {
        mocks.mediaGet.mockResolvedValue({ Blob: new Blob(['x']), ByteSize: 1, SongId: 's1' });

        const { result, unmount } = renderHook(() => useSongUrl(SONG, true, TRANSCODE), {
            wrapper,
        });
        await waitFor(() => expect(result.current).toBe('blob:fake-object-url'));

        unmount();
        expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake-object-url');
    });
});
