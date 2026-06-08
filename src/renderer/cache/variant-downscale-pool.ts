// Bounded pool of downscale workers (see variant-downscale.worker.ts).
//
// The thumbnail sweep's fetch concurrency (localCache.thumbnailConcurrency, up
// to 64) feeds this pool: each fetched cover is downscaled+encoded in a worker
// so the CPU-bound work parallelises across cores instead of serialising on the
// renderer main thread (the dominant cost on a populated library — a full
// thumbnail sweep was bottlenecked at ~1 item/sec by single-threaded encodes).
//
// Falls back to a synchronous main-thread downscale when Workers or
// OffscreenCanvas aren't available (e.g. some older WebViews), so behaviour is
// unchanged where the off-thread path can't run.
import {
    type DownscaledBlob,
    type DownscaleOptions,
    downscaleToVariants,
    type DownscaleVariant,
} from '/@/renderer/cache/variant-downscale';

const TAG = '[image-variants]';

interface PoolJob {
    options: DownscaleOptions;
    reject: (err: Error) => void;
    resolve: (out: Map<string, DownscaledBlob>) => void;
    srcBuffer: ArrayBuffer;
    srcType: string;
    variants: DownscaleVariant[];
}

interface WorkerResultEntry {
    buffer: ArrayBuffer;
    format: 'jpeg' | 'webp';
    type: string;
    variant: string;
}

// OffscreenCanvas in a module worker is what makes the off-thread path possible.
const offThreadSupported =
    typeof Worker !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined' &&
    typeof createImageBitmap !== 'undefined';

// One worker per ~core, capped: enough to saturate the CPU for encodes without
// holding excessive image buffers in flight. Renderer reports the host core
// count via navigator.hardwareConcurrency.
const POOL_SIZE = (() => {
    const cores =
        typeof navigator !== 'undefined' && navigator.hardwareConcurrency
            ? navigator.hardwareConcurrency
            : 4;
    return Math.min(Math.max(2, cores - 1), 12);
})();

interface PooledWorker {
    busyId: null | number;
    worker: Worker;
}

let pool: null | PooledWorker[] = null;
const idle: PooledWorker[] = [];
const queue: PoolJob[] = [];
const pending = new Map<number, PoolJob>();
let nextJobId = 1;
let warnedSpawnFailure = false;

const spawnPool = (): boolean => {
    if (pool) return true;
    try {
        pool = [];
        for (let i = 0; i < POOL_SIZE; i += 1) {
            const worker = new Worker(new URL('./variant-downscale.worker.ts', import.meta.url), {
                type: 'module',
            });
            const pw: PooledWorker = { busyId: null, worker };
            worker.onmessage = (
                event: MessageEvent<
                    | { error: string; id: number; ok: false }
                    | { id: number; ok: true; out: WorkerResultEntry[] }
                >,
            ) => {
                const msg = event.data;
                const job = pending.get(msg.id);
                pending.delete(msg.id);
                pw.busyId = null;
                idle.push(pw);
                pumpQueue();
                if (!job) return;
                if (msg.ok) {
                    const out = new Map<string, DownscaledBlob>();
                    for (const entry of msg.out) {
                        out.set(entry.variant, {
                            blob: new Blob([entry.buffer], { type: entry.type }),
                            format: entry.format,
                        });
                    }
                    job.resolve(out);
                } else {
                    job.reject(new Error(msg.error));
                }
            };
            worker.onerror = (err) => {
                // A worker that hard-errors: fail its in-flight job (the sweep
                // treats a rejection as a miss and moves on) and recycle the slot.
                const id = pw.busyId;
                pw.busyId = null;
                if (id != null) {
                    const job = pending.get(id);
                    pending.delete(id);
                    job?.reject(new Error(err.message || 'downscale worker error'));
                }
                idle.push(pw);
                pumpQueue();
            };
            pool.push(pw);
            idle.push(pw);
        }
        console.info(`${TAG} downscale worker pool started`, { workers: POOL_SIZE });
        return true;
    } catch (err) {
        if (!warnedSpawnFailure) {
            warnedSpawnFailure = true;
            console.warn(`${TAG} worker pool unavailable, using main-thread downscale`, {
                error: (err as Error)?.message ?? String(err),
            });
        }
        pool = null;
        return false;
    }
};

const dispatch = (pw: PooledWorker, job: PoolJob): void => {
    const id = nextJobId;
    nextJobId += 1;
    pw.busyId = id;
    pending.set(id, job);
    // Transfer the source buffer into the worker (zero-copy).
    pw.worker.postMessage(
        {
            id,
            options: job.options,
            srcBuffer: job.srcBuffer,
            srcType: job.srcType,
            variants: job.variants,
        },
        [job.srcBuffer],
    );
};

const pumpQueue = (): void => {
    while (queue.length > 0 && idle.length > 0) {
        const pw = idle.pop()!;
        const job = queue.shift()!;
        dispatch(pw, job);
    }
};

/**
 * Downscale a source cover into every requested variant, running the
 * decode/encode in a worker pool. API-compatible with `downscaleToVariants`
 * (returns the same `Map<variant, { blob, format }>`); transparently falls back
 * to the synchronous main-thread implementation where workers aren't available.
 */
export const downscaleVariantsPooled = async (
    srcBlob: Blob,
    variants: DownscaleVariant[],
    options: DownscaleOptions,
): Promise<Map<string, DownscaledBlob>> => {
    if (variants.length === 0) return new Map();
    if (!offThreadSupported || !spawnPool()) {
        return downscaleToVariants(srcBlob, variants, options);
    }
    const srcBuffer = await srcBlob.arrayBuffer();
    return new Promise<Map<string, DownscaledBlob>>((resolve, reject) => {
        const job: PoolJob = {
            options,
            reject,
            resolve,
            srcBuffer,
            srcType: srcBlob.type,
            variants,
        };
        const pw = idle.pop();
        if (pw) dispatch(pw, job);
        else queue.push(job);
    });
};

/** Tear the pool down (e.g. on teardown / tests). Idempotent. */
export const terminateDownscalePool = (): void => {
    if (!pool) return;
    for (const pw of pool) pw.worker.terminate();
    pool = null;
    idle.length = 0;
    queue.length = 0;
    pending.clear();
};
