/// <reference lib="webworker" />

import { computeIntensity } from '/@/renderer/features/trackmap/analysis/dsp';
import { TRACKMAP_DATA_VERSION, type TrackmapData } from '/@/renderer/features/trackmap/types';

// Web Worker entry. The main thread does the audio decode (because
// OfflineAudioContext is NOT exposed in DedicatedWorkerGlobalScope in
// Chromium / Electron — a Web Audio API spec gap, not a Vite issue) and
// posts the already-decoded mono Float32Array here. The worker only
// runs the DSP loop (FFT + onset detection + binning), which is the
// expensive part. Posting back transfers the bins buffer to avoid the
// last ~1 KB copy.

export interface TrackmapWorkerRequest {
    monoSamples: Float32Array;
    sampleRate: number;
    sensitivity: number;
    type: 'analyze';
}

export interface TrackmapWorkerResponse {
    data?: TrackmapData;
    message?: string;
    type: 'error' | 'result';
}

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.onmessage = (event: MessageEvent<TrackmapWorkerRequest>) => {
    const req = event.data;
    if (req.type !== 'analyze') return;

    try {
        const bins = computeIntensity(req.monoSamples, req.sampleRate, req.sensitivity);

        const result: TrackmapData = {
            bins,
            computedAt: Date.now(),
            durationMs: Math.round((req.monoSamples.length / req.sampleRate) * 1000),
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
