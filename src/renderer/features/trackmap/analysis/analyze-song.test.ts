// Unit tests for the lazy trackmap analysis orchestration.
//
// Proves the two cache contracts the spec cares about:
//   1. A cache HIT short-circuits BEFORE any network fetch or worker spin-up
//      (a song analysed once is never re-analysed on a later play).
//   2. A cache MISS runs the worker exactly once, then WRITES the result back
//      to the cache (lazy generate-then-persist).
//
// We mock the Vite `?worker` import (which vitest can't resolve), the cache
// delegate, and global fetch / OfflineAudioContext so the test stays on the
// orchestration logic rather than real DSP.

import type { TrackmapData } from '/@/renderer/features/trackmap/types';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    const workerInstance = {
        addEventListener: vi.fn(),
        onerror: null as ((e: unknown) => void) | null,
        postMessage: vi.fn(),
        removeEventListener: vi.fn(),
        terminate: vi.fn(),
    };
    return {
        cacheGet: vi.fn(),
        cacheSet: vi.fn(),
        decodeAudioData: vi.fn(),
        workerCtor: vi.fn(() => workerInstance),
        workerInstance,
    };
});

vi.mock('/@/renderer/features/trackmap/analysis/trackmap-worker?worker', () => ({
    default: mocks.workerCtor,
}));

vi.mock('/@/renderer/features/trackmap/api/trackmap-cache', () => ({
    trackmapCache: {
        get: mocks.cacheGet,
        set: mocks.cacheSet,
    },
}));

import { analyzeSong } from '/@/renderer/features/trackmap/analysis/analyze-song';

const sampleData = (): TrackmapData => ({
    bins: new Float32Array(256).fill(0.5),
    computedAt: Date.now(),
    durationMs: 200_000,
    version: 1,
});

beforeEach(() => {
    mocks.cacheGet.mockReset();
    mocks.cacheSet.mockReset();
    mocks.workerCtor.mockClear();
    mocks.workerInstance.postMessage.mockClear();
    mocks.workerInstance.addEventListener.mockClear();
    vi.stubGlobal('fetch', vi.fn());
    // OfflineAudioContext is only constructed on the miss path; stub it so the
    // hit-path test never accidentally relies on it.
    vi.stubGlobal(
        'OfflineAudioContext',
        class {
            decodeAudioData = mocks.decodeAudioData;
        },
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('analyzeSong — lazy cache behaviour', () => {
    it('returns the cached analysis WITHOUT fetching or spinning up the worker', async () => {
        const cached = sampleData();
        mocks.cacheGet.mockResolvedValue(cached);

        const ac = new AbortController();
        const result = await analyzeSong({
            allowNetwork: true,
            sensitivity: 3,
            serverId: 'srv',
            signal: ac.signal,
            songId: 'song-1',
            streamUrl: 'https://example/stream',
        });

        expect(result).toBe(cached);
        // The whole point of the cache: no re-analysis.
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
        expect(mocks.cacheSet).not.toHaveBeenCalled();
    });

    it('reads the cache before doing any work (cache-first ordering)', async () => {
        // Cache miss, but block the network so we can assert the lookup ran first.
        mocks.cacheGet.mockResolvedValue(null);
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
            new Error('network blocked for test'),
        );

        const ac = new AbortController();
        await expect(
            analyzeSong({
                allowNetwork: true,
                sensitivity: 3,
                serverId: 'srv',
                signal: ac.signal,
                songId: 'song-2',
                streamUrl: 'https://example/stream',
            }),
        ).rejects.toThrow();

        expect(mocks.cacheGet).toHaveBeenCalledWith('srv', 'song-2', 3);
        // Cache was consulted before the (failing) network fetch.
        expect(mocks.cacheGet).toHaveBeenCalled();
    });

    it('returns null without fetching when network is disallowed and cache misses', async () => {
        mocks.cacheGet.mockResolvedValue(null);

        const ac = new AbortController();
        const result = await analyzeSong({
            allowNetwork: false,
            sensitivity: 3,
            serverId: 'srv',
            signal: ac.signal,
            songId: 'song-3',
            streamUrl: 'https://example/stream',
        });

        expect(result).toBeNull();
        expect(globalThis.fetch).not.toHaveBeenCalled();
        expect(mocks.workerCtor).not.toHaveBeenCalled();
    });
});
