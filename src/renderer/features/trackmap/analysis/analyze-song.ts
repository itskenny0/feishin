import type {
    TrackmapWorkerRequest,
    TrackmapWorkerResponse,
} from '/@/renderer/features/trackmap/analysis/trackmap-worker';
import type { TrackmapData } from '/@/renderer/features/trackmap/types';

import TrackmapWorker from '/@/renderer/features/trackmap/analysis/trackmap-worker?worker';
import { trackmapCache } from '/@/renderer/features/trackmap/api/trackmap-cache';

// Singleton worker. Lazy-created on first use, recreated on crash.
let worker: null | Worker = null;
const getWorker = (): Worker => {
    if (!worker) {
        worker = new TrackmapWorker();
        worker.onerror = (err) => {
            console.warn('[trackmap] worker crashed', err);
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

interface AnalyzeArgs {
    allowNetwork: boolean;
    sensitivity: number;
    serverId: string;
    signal: AbortSignal;
    songId: string;
    streamUrl: string | undefined;
}

/**
 * Try the cache; if hit, return. Otherwise, optionally fetch + decode
 * via the worker. allowNetwork=false short-circuits after the cache
 * lookup — used by the "Only over LAN" setting.
 *
 * Returns null for legitimate skip (LAN-only gate triggered, no cached
 * result). Throws on actual error (fetch failure, worker decode failure,
 * abort).
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
            arrayBuffer,
            sensitivity,
            type: 'analyze',
        };
        w.postMessage(req, [arrayBuffer]);
    });

    currentJob = null;

    void trackmapCache.set(serverId, songId, sensitivity, data);

    return data;
};
