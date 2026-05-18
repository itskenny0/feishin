import type {
    TrackmapWorkerRequest,
    TrackmapWorkerResponse,
} from '/@/renderer/features/trackmap/analysis/trackmap-worker';
import type { TrackmapData } from '/@/renderer/features/trackmap/types';

import TrackmapWorker from '/@/renderer/features/trackmap/analysis/trackmap-worker?worker';
import { trackmapCache } from '/@/renderer/features/trackmap/api/trackmap-cache';

// Decode sample rate — purely a latency knob for decodeAudioData. We don't
// need 44.1 kHz fidelity for an intensity curve; 8 kHz makes the decode
// path noticeably faster on long songs without changing the output shape.
const DECODE_SR = 8000;

// One shared main-thread OfflineAudioContext for decodeAudioData. The
// audio decode lives on the main thread because OfflineAudioContext is
// NOT exposed in DedicatedWorkerGlobalScope in Chromium / Electron —
// it's a known Web Audio API spec gap, not a Vite issue. The worker
// only runs the DSP loop, which is the actual hot path.
let decodeCtx: null | OfflineAudioContext = null;
const getDecodeCtx = (): OfflineAudioContext => {
    if (!decodeCtx) {
        // (1, 1, DECODE_SR): minimal — we never call startRendering(),
        // so the render buffer is unused; decodeAudioData ignores the
        // configured length entirely.
        decodeCtx = new OfflineAudioContext(1, 1, DECODE_SR);
    }
    return decodeCtx;
};

// Singleton worker. Lazy-created on first use, recreated on crash.
let worker: null | Worker = null;
const getWorker = (): Worker => {
    if (!worker) {
        worker = new TrackmapWorker();
        worker.onerror = (err) => {
            console.warn('[trackmap] worker crashed', err);
            // Reject any in-flight job so the consumer doesn't hang.
            if (currentJob && !currentJob.aborted) {
                currentJob.aborted = true;
                currentJob.reject(new Error('trackmap worker crashed'));
            }
            worker?.terminate();
            worker = null;
        };
    }
    return worker;
};

// Single in-flight job — we don't parallelise; concurrent calls supersede.
let currentJob: null | {
    aborted: boolean;
    reject: (e: Error) => void;
    resolve: (d: TrackmapData) => void;
} = null;

/** Downmix any-channel AudioBuffer to a single mono Float32Array. */
const downmixToMono = (audioBuffer: AudioBuffer): Float32Array => {
    const channels = audioBuffer.numberOfChannels;
    const length = audioBuffer.length;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels; c += 1) {
        const data = audioBuffer.getChannelData(c);
        for (let i = 0; i < length; i += 1) {
            mono[i] += data[i] / channels;
        }
    }
    return mono;
};

interface AnalyzeArgs {
    allowNetwork: boolean;
    sensitivity: number;
    serverId: string;
    signal: AbortSignal;
    songId: string;
    streamUrl: string | undefined;
}

/**
 * Try the cache; if hit, return. Otherwise, optionally fetch the song
 * bytes, decode them on the main thread, and post the mono PCM to the
 * worker for DSP. `allowNetwork = false` short-circuits after the cache
 * lookup — used by the "Only over LAN" setting.
 *
 * Returns `null` for legitimate skip (LAN-only gate triggered, no cached
 * result). Throws on actual error (fetch failure, decode failure, worker
 * decode failure, abort).
 */
export const analyzeSong = async (args: AnalyzeArgs): Promise<null | TrackmapData> => {
    const { allowNetwork, sensitivity, serverId, signal, songId, streamUrl } = args;

    const cached = await trackmapCache.get(serverId, songId, sensitivity);
    if (cached) return cached;

    if (!allowNetwork) return null;
    if (!streamUrl) return null;

    const response = await fetch(streamUrl, { signal });
    if (!response.ok) {
        throw new Error(`trackmap fetch failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');

    // Decode on the main thread (where OfflineAudioContext is available).
    // decodeAudioData detaches `arrayBuffer` so the caller must not reuse it.
    const audioBuffer = await getDecodeCtx().decodeAudioData(arrayBuffer);
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');

    const monoSamples = downmixToMono(audioBuffer);

    // Supersede any in-flight worker job.
    if (currentJob && !currentJob.aborted) {
        currentJob.aborted = true;
        currentJob.reject(new DOMException('superseded', 'AbortError'));
    }

    const w = getWorker();
    const data = await new Promise<TrackmapData>((resolve, reject) => {
        const thisJob = { aborted: false, reject, resolve };
        currentJob = thisJob;

        const onMessage = (event: MessageEvent<TrackmapWorkerResponse>) => {
            if (thisJob.aborted) return;
            const res = event.data;
            w.removeEventListener('message', onMessage);
            if (res.type === 'result' && res.data) {
                resolve(res.data);
            } else {
                reject(new Error(res.message ?? 'worker error'));
            }
        };
        w.addEventListener('message', onMessage);

        signal.addEventListener('abort', () => {
            if (!thisJob.aborted) {
                thisJob.aborted = true;
                w.removeEventListener('message', onMessage);
                reject(new DOMException('aborted', 'AbortError'));
            }
        });

        const req: TrackmapWorkerRequest = {
            monoSamples,
            sampleRate: audioBuffer.sampleRate,
            sensitivity,
            type: 'analyze',
        };
        // Transfer the mono PCM buffer so we don't copy ~7 MB of Float32 per song.
        w.postMessage(req, [monoSamples.buffer]);
    });

    currentJob = null;

    void trackmapCache.set(serverId, songId, sensitivity, data);

    return data;
};
