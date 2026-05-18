/// <reference lib="webworker" />

import { computeIntensity } from '/@/renderer/features/trackmap/analysis/dsp';
import { TRACKMAP_DATA_VERSION, type TrackmapData } from '/@/renderer/features/trackmap/types';

// Web Worker entry. The main thread posts an ArrayBuffer of the encoded
// song bytes plus the sensitivity setting; the worker decodes the audio,
// computes the intensity hybrid, and posts a Float32Array back. The
// underlying buffer is transferred to avoid a copy.

export interface TrackmapWorkerRequest {
    arrayBuffer: ArrayBuffer;
    sensitivity: number;
    type: 'analyze';
}

export interface TrackmapWorkerResponse {
    data?: TrackmapData;
    message?: string;
    type: 'error' | 'result';
}

const TARGET_SR = 8000;

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = async (event: MessageEvent<TrackmapWorkerRequest>) => {
    const req = event.data;
    if (req.type !== 'analyze') return;

    try {
        // Minimal length — we only need the context to host decodeAudioData;
        // startRendering() is never called, so the render buffer is never used.
        // A 3-hour allocation here would waste ~346 MB per analysis.
        const offline = new OfflineAudioContext(1, 1, TARGET_SR);
        const audioBuffer = await offline.decodeAudioData(req.arrayBuffer);

        // Downmix to mono if stereo.
        const channels = audioBuffer.numberOfChannels;
        const length = audioBuffer.length;
        const mono = new Float32Array(length);
        for (let c = 0; c < channels; c += 1) {
            const data = audioBuffer.getChannelData(c);
            for (let i = 0; i < length; i += 1) {
                mono[i] += data[i] / channels;
            }
        }

        // computeIntensity uses the decoded buffer's native sample rate, not 8 kHz.
        // The 8 kHz on the OfflineAudioContext is purely for decode latency.
        const bins = computeIntensity(mono, audioBuffer.sampleRate, req.sensitivity);

        const result: TrackmapData = {
            bins,
            computedAt: Date.now(),
            durationMs: Math.round((length / audioBuffer.sampleRate) * 1000),
            version: TRACKMAP_DATA_VERSION,
        };

        ctx.postMessage({ data: result, type: 'result' } satisfies TrackmapWorkerResponse, [
            bins.buffer,
        ]);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.postMessage({ message, type: 'error' } satisfies TrackmapWorkerResponse);
    }
};
