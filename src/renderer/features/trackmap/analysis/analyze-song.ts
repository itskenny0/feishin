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

// Android/iOS WebViews get a fraction of desktop memory. decodeAudioData
// internally expands the WHOLE compressed file to PCM before resampling —
// a full-quality local copy (offline playback serves the original file as a
// blob) can transiently allocate hundreds of MB, and Android's low-memory
// killer takes the app down ~200ms into playback. On native platforms, skip
// analysis of sources above this compressed-size cap; cached analyses (and
// reasonably-sized files) still work everywhere.
const MAX_ANALYSIS_BYTES_CONSTRAINED = 12 * 1024 * 1024;

let constrainedMemoryPlatform = false;
void (async () => {
    try {
        const { Capacitor } = await import('@capacitor/core');
        constrainedMemoryPlatform = Capacitor.isNativePlatform();
    } catch {
        // Not a Capacitor runtime (Electron / plain web) — desktop memory.
    }
})();

/** Test-only override for the constrained-memory platform guard. */
export const __setConstrainedMemoryPlatformForTests = (value: boolean): void => {
    constrainedMemoryPlatform = value;
};

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
// `requestId` correlates worker responses with the job that asked for them,
// so a slow analysis whose song was switched away from cannot poison the
// cache by being delivered to a later (different-song) listener.
let currentJob: null | {
    aborted: boolean;
    reject: (e: Error) => void;
    requestId: number;
    resolve: (d: TrackmapData) => void;
} = null;

let nextRequestId = 1;

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
    // Go through blob() so the size is known BEFORE committing to a decode —
    // for blob: sources this is a cheap reference, not a copy.
    const audioBlob = await response.blob();
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (constrainedMemoryPlatform && audioBlob.size > MAX_ANALYSIS_BYTES_CONSTRAINED) {
        console.info('[trackmap] skipping analysis: source too large for this platform', {
            bytes: audioBlob.size,
            songId,
        });
        return null;
    }
    const arrayBuffer = await audioBlob.arrayBuffer();
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

    const requestId = nextRequestId;
    nextRequestId += 1;

    const w = getWorker();
    const data = await new Promise<TrackmapData>((resolve, reject) => {
        const thisJob = { aborted: false, reject, requestId, resolve };
        currentJob = thisJob;

        // Remove BOTH listeners on every terminal path. Previously the
        // 'abort' listener was only detached when the AbortSignal was
        // GC'd, so a caller holding the controller for the track's
        // lifetime would retain this closure (and `thisJob`, `w`,
        // `onMessage`) until then.
        const cleanup = () => {
            w.removeEventListener('message', onMessage);
            signal.removeEventListener('abort', onAbort);
        };

        const onMessage = (event: MessageEvent<TrackmapWorkerResponse>) => {
            const res = event.data;
            // Ignore late responses from a superseded job. Without this
            // guard, the new listener would happily resolve with the
            // previous song's data and poison the cache under the new
            // song's key (the worker is single-threaded, so an in-flight
            // analysis from a song-switch-away can fire here before the
            // current job's response).
            if (res.requestId !== thisJob.requestId) return;
            if (thisJob.aborted) return;
            cleanup();
            if (res.type === 'result' && res.data) {
                resolve(res.data);
            } else {
                reject(new Error(res.message ?? 'worker error'));
            }
        };

        const onAbort = () => {
            if (!thisJob.aborted) {
                thisJob.aborted = true;
                cleanup();
                reject(new DOMException('aborted', 'AbortError'));
            }
        };

        w.addEventListener('message', onMessage);
        signal.addEventListener('abort', onAbort);

        const req: TrackmapWorkerRequest = {
            monoSamples,
            requestId,
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
