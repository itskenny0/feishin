// Downscale pipeline for the multi-resolution artwork-variant cache.
//
// `downscaleToVariants(srcBlob, variants, { format, quality })` decodes a single
// source cover once (via `createImageBitmap`) and produces one re-encoded blob
// per requested variant by drawing the decoded bitmap into a canvas sized to the
// variant's target px and re-encoding. This is the "downscale locally" mode:
// one network fetch per item, then N cheap canvas resizes — instead of N server
// round-trips.
//
// Encoding:
//  - `format: 'webp'` re-encodes to `image/webp` at `quality`. Some webviews
//    (notably older Capacitor WebViews) can't encode WebP from a canvas; when
//    that happens the encode returns null / rejects and we transparently retry
//    as `image/jpeg`, logging once per affected variant.
//  - `format: 'jpeg'` re-encodes to `image/jpeg` directly (no WebP attempt).
//
// Sizing:
//  - The longest source edge is clamped to the variant px (aspect preserved).
//  - We never upscale: a target larger than the source clamps to the source.
//  - `px === 0` means "original" — the source intrinsic size is used as-is.
//
// Decoding uses a `blob:`-backed `ImageBitmap`, which is NOT CORS-tainted, so
// this works for header-authenticated backends (Jellyfin) as well as Subsonic.

export interface DownscaledBlob {
    blob: Blob;
    format: VariantFormat;
}

export interface DownscaleOptions {
    format: VariantFormat;
    quality: number;
}

export interface DownscaleVariant {
    px: number;
    variant: string;
}

export type VariantFormat = 'jpeg' | 'webp';

const mimeFor = (format: VariantFormat): string =>
    format === 'webp' ? 'image/webp' : 'image/jpeg';

interface CanvasLike {
    convertToBlob?: (opts: { quality?: number; type?: string }) => Promise<Blob>;
    getContext: (id: '2d') => CanvasRenderingContext2D | null;
    height: number;
    toBlob?: (cb: (blob: Blob | null) => void, type?: string, quality?: number) => void;
    width: number;
}

/**
 * Allocate a drawing surface, preferring `OffscreenCanvas` (works off the main
 * thread / in workers) and falling back to a detached `<canvas>` element.
 */
const createCanvas = (width: number, height: number): CanvasLike => {
    if (typeof OffscreenCanvas !== 'undefined') {
        return new OffscreenCanvas(width, height) as unknown as CanvasLike;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas as unknown as CanvasLike;
};

/**
 * Encode a canvas to a blob of the given MIME, returning null when the webview
 * can't produce that format. Handles both the `OffscreenCanvas.convertToBlob`
 * (promise) and `<canvas>.toBlob` (callback) APIs.
 */
const encodeCanvas = async (
    canvas: CanvasLike,
    mime: string,
    quality: number,
): Promise<Blob | null> => {
    // OffscreenCanvas
    if (typeof canvas.convertToBlob === 'function') {
        try {
            const blob = await canvas.convertToBlob({ quality, type: mime });
            // A browser that doesn't support the requested type silently encodes
            // PNG instead — treat a mismatched type as unsupported so the caller
            // can fall back.
            if (!blob || (blob.type && blob.type !== mime)) return null;
            return blob;
        } catch {
            return null;
        }
    }

    // HTMLCanvasElement
    if (typeof canvas.toBlob === 'function') {
        return new Promise<Blob | null>((resolve) => {
            canvas.toBlob!(
                (blob) => {
                    if (!blob || (blob.type && blob.type !== mime)) {
                        resolve(null);
                        return;
                    }
                    resolve(blob);
                },
                mime,
                quality,
            );
        });
    }

    return null;
};

/**
 * Compute the target draw dimensions for a variant: the longest edge clamped to
 * `px` with aspect preserved, never upscaling. `px === 0` → the source size.
 */
const targetDimensions = (
    srcWidth: number,
    srcHeight: number,
    px: number,
): { height: number; width: number } => {
    if (px <= 0) return { height: srcHeight, width: srcWidth };

    const longest = Math.max(srcWidth, srcHeight);
    // Never upscale.
    if (longest <= px) return { height: srcHeight, width: srcWidth };

    const scale = px / longest;
    return {
        height: Math.max(1, Math.round(srcHeight * scale)),
        width: Math.max(1, Math.round(srcWidth * scale)),
    };
};

/**
 * Decode `srcBlob` once and produce one re-encoded blob per requested variant.
 * Returns a `Map<variant, { blob, format }>`. Variants that fail to encode in
 * any supported format are omitted from the map (the caller treats them as a
 * miss). WebP that can't be produced auto-falls back to JPEG.
 */
export const downscaleToVariants = async (
    srcBlob: Blob,
    variants: DownscaleVariant[],
    { format, quality }: DownscaleOptions,
): Promise<Map<string, DownscaledBlob>> => {
    const out = new Map<string, DownscaledBlob>();
    if (variants.length === 0) return out;

    // canvas.toBlob/convertToBlob expect quality in [0, 1]; the config carries
    // it as 1-100. Be tolerant of a value already in [0, 1].
    const normalizedQuality = quality > 1 ? quality / 100 : quality;

    const bitmap = await createImageBitmap(srcBlob);
    const srcWidth = bitmap.width;
    const srcHeight = bitmap.height;

    try {
        // Each variant gets its OWN canvas and only READS the shared (immutable)
        // bitmap via drawImage, so the encodes don't share a surface and can run
        // concurrently. Producing them in parallel lets a single source's N
        // re-encodes overlap (and, inside a worker, use the event loop fully)
        // instead of serialising one webp encode after another.
        const produced = await Promise.all(
            variants.map(async ({ px, variant }) => {
                const { height, width } = targetDimensions(srcWidth, srcHeight, px);

                const canvas = createCanvas(width, height);
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    console.warn(
                        `[image-variants] no 2d context for variant "${variant}", skipping`,
                    );
                    return null;
                }
                ctx.drawImage(
                    bitmap as unknown as CanvasImageSource,
                    0,
                    0,
                    srcWidth,
                    srcHeight,
                    0,
                    0,
                    width,
                    height,
                );

                let blob = await encodeCanvas(canvas, mimeFor(format), normalizedQuality);
                let producedFormat: VariantFormat = format;

                if (!blob && format === 'webp') {
                    console.warn(
                        `[image-variants] webp unsupported, fell back to jpeg (variant "${variant}")`,
                    );
                    blob = await encodeCanvas(canvas, mimeFor('jpeg'), normalizedQuality);
                    producedFormat = 'jpeg';
                }

                if (!blob) {
                    console.warn(
                        `[image-variants] failed to encode variant "${variant}" (${width}x${height})`,
                    );
                    return null;
                }

                return { blob, format: producedFormat, variant };
            }),
        );
        for (const entry of produced) {
            if (entry) out.set(entry.variant, { blob: entry.blob, format: entry.format });
        }
    } finally {
        // Free the decoded bitmap promptly (no-op if unsupported).
        if (typeof (bitmap as ImageBitmap).close === 'function') {
            (bitmap as ImageBitmap).close();
        }
    }

    console.info(
        `[image-variants] downscaled ${out.size}/${variants.length} variant(s) from ${srcWidth}x${srcHeight} source`,
    );

    return out;
};
