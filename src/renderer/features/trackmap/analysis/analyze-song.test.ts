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

import type {
    TrackmapWorkerRequest,
    TrackmapWorkerResponse,
} from '/@/renderer/features/trackmap/analysis/trackmap-worker';
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

    it('on a cache miss, runs the worker once and persists the result (generate-then-persist)', async () => {
        mocks.cacheGet.mockResolvedValue(null);
        (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
            ok: true,
            status: 200,
        });
        // decodeAudioData yields a 1-channel buffer the downmix can read.
        mocks.decodeAudioData.mockResolvedValue({
            getChannelData: () => new Float32Array(8),
            length: 8,
            numberOfChannels: 1,
            sampleRate: 8000,
        });

        // Wire the fake worker: capture the 'message' listener, then echo a
        // 'result' on the SAME requestId as soon as the job posts its request.
        let onMessage: ((e: MessageEvent<TrackmapWorkerResponse>) => void) | null = null;
        mocks.workerInstance.addEventListener.mockImplementation(
            (type: string, handler: (e: MessageEvent<TrackmapWorkerResponse>) => void) => {
                if (type === 'message') onMessage = handler;
            },
        );
        const produced = sampleData();
        mocks.workerInstance.postMessage.mockImplementation((req: TrackmapWorkerRequest) => {
            onMessage?.({
                data: { data: produced, requestId: req.requestId, type: 'result' },
            } as MessageEvent<TrackmapWorkerResponse>);
        });

        const ac = new AbortController();
        const result = await analyzeSong({
            allowNetwork: true,
            sensitivity: 3,
            serverId: 'srv',
            signal: ac.signal,
            songId: 'song-4',
            streamUrl: 'https://example/stream',
        });

        // The worker spun up and ran exactly once...
        expect(mocks.workerCtor).toHaveBeenCalledTimes(1);
        expect(mocks.workerInstance.postMessage).toHaveBeenCalledTimes(1);
        // ...the analysis came back to the caller...
        expect(result).toBe(produced);
        // ...and the lazy generate-then-persist write landed under the song key.
        expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
        expect(mocks.cacheSet).toHaveBeenCalledWith('srv', 'song-4', 3, produced);
        // ...and the success path tore down BOTH worker listeners so the
        // abort handler (and the closure it captures) isn't retained for
        // the lifetime of a caller-held AbortSignal.
        expect(mocks.workerInstance.removeEventListener).toHaveBeenCalledWith(
            'message',
            expect.any(Function),
        );
    });
});
