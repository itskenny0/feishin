// Web Worker that runs the artwork downscale/encode off the renderer main
// thread. The thumbnail sweep fetches each cover on the main thread, then hands
// the source bytes to a pool of these workers (see variant-downscale-pool.ts):
// `createImageBitmap` + canvas re-encode are CPU-bound, and doing them on the
// main thread serialised every item behind a single core (and froze the UI
// during a sync). Running them in workers parallelises across cores and keeps
// the UI responsive.
//
// `downscaleToVariants` already uses only OffscreenCanvas + createImageBitmap
// (no DOM), so it runs unchanged inside a worker.
import {
    type DownscaleOptions,
    downscaleToVariants,
    type DownscaleVariant,
} from '/@/renderer/cache/variant-downscale';

interface DownscaleRequest {
    id: number;
    options: DownscaleOptions;
    srcBuffer: ArrayBuffer;
    srcType: string;
    variants: DownscaleVariant[];
}

self.onmessage = async (event: MessageEvent<DownscaleRequest>) => {
    const { id, options, srcBuffer, srcType, variants } = event.data;
    try {
        const srcBlob = new Blob([srcBuffer], { type: srcType || 'image/jpeg' });
        const produced = await downscaleToVariants(srcBlob, variants, options);

        // Convert each produced Blob to a transferable ArrayBuffer so the main
        // thread doesn't pay a structured-clone copy of the image bytes.
        const out: { buffer: ArrayBuffer; format: string; type: string; variant: string }[] = [];
        const transfer: ArrayBuffer[] = [];
        for (const [variant, { blob, format }] of produced) {
            const buffer = await blob.arrayBuffer();
            out.push({ buffer, format, type: blob.type, variant });
            transfer.push(buffer);
        }
        (self as unknown as Worker).postMessage({ id, ok: true, out }, transfer);
    } catch (err) {
        (self as unknown as Worker).postMessage({
            error: (err as Error)?.message ?? String(err),
            id,
            ok: false,
        });
    }
};
