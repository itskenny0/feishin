import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { downscaleToVariants } from '/@/renderer/cache/variant-downscale';

// jsdom implements neither `createImageBitmap`, `OffscreenCanvas`, nor a real
// canvas raster backend, so the downscale pipeline is exercised against a small
// fake that records what the implementation asked for (target width, mime,
// quality) and synthesises a tiny Blob in return.

interface DrawCall {
    height: number;
    width: number;
}

interface EncodeCall {
    height: number;
    quality: number | undefined;
    type: string;
    width: number;
}

const SRC_WIDTH = 1000;
const SRC_HEIGHT = 1000;

let drawCalls: DrawCall[] = [];
let encodeCalls: EncodeCall[] = [];
// MIME types for which the fake canvas refuses to encode (returns null),
// emulating a webview without WebP encode support.
let unsupportedMimes = new Set<string>();

const makeBlob = (type: string): Blob => new Blob(['x'], { type });

const installCanvasFakes = ({
    bitmapHeight = SRC_HEIGHT,
    bitmapWidth = SRC_WIDTH,
}: { bitmapHeight?: number; bitmapWidth?: number } = {}): void => {
    drawCalls = [];
    encodeCalls = [];

    vi.stubGlobal(
        'createImageBitmap',
        vi.fn(async () => ({
            close: vi.fn(),
            height: bitmapHeight,
            width: bitmapWidth,
        })),
    );

    class FakeCanvas {
        height = 0;

        width = 0;

        // OffscreenCanvas path.
        convertToBlob({ quality, type }: { quality?: number; type?: string } = {}): Promise<Blob> {
            const mime = type ?? 'image/png';
            encodeCalls.push({
                height: this.height,
                quality,
                type: mime,
                width: this.width,
            });
            if (unsupportedMimes.has(mime)) {
                return Promise.reject(new Error(`unsupported: ${mime}`));
            }
            return Promise.resolve(makeBlob(mime));
        }

        getContext(): unknown {
            return {
                drawImage: (
                    _img: unknown,
                    _sx: number,
                    _sy: number,
                    _sw: number,
                    _sh: number,
                    _dx: number,
                    _dy: number,
                    dw: number,
                    dh: number,
                ) => {
                    drawCalls.push({ height: dh, width: dw });
                },
            };
        }

        // <canvas> path.
        toBlob(cb: (blob: Blob | null) => void, type?: string, quality?: number): void {
            const mime = type ?? 'image/png';
            encodeCalls.push({ height: this.height, quality, type: mime, width: this.width });
            cb(unsupportedMimes.has(mime) ? null : makeBlob(mime));
        }
    }

    vi.stubGlobal(
        'OffscreenCanvas',
        class extends FakeCanvas {
            constructor(width: number, height: number) {
                super();
                this.width = width;
                this.height = height;
            }
        },
    );

    // Provide document.createElement('canvas') fallback too.
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
        if (tag === 'canvas') {
            return new FakeCanvas() as unknown as HTMLCanvasElement;
        }
        return realCreate(tag);
    }) as unknown as typeof document.createElement);
};

beforeEach(() => {
    unsupportedMimes = new Set();
    installCanvasFakes();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('downscaleToVariants', () => {
    it('produces a Map of variant -> webp blob at the requested sizes', async () => {
        const src = makeBlob('image/jpeg');
        const result = await downscaleToVariants(
            src,
            [
                { px: 80, variant: 'table' },
                { px: 300, variant: 'itemCard' },
            ],
            { format: 'webp', quality: 82 },
        );

        expect(result.size).toBe(2);
        expect(result.get('table')?.format).toBe('webp');
        expect(result.get('table')?.blob.type).toBe('image/webp');
        expect(result.get('itemCard')?.blob.type).toBe('image/webp');

        // Square source -> square targets at the requested px.
        const sizes = encodeCalls.map((c) => `${c.width}x${c.height}`).sort();
        expect(sizes).toContain('80x80');
        expect(sizes).toContain('300x300');

        // Quality was forwarded.
        expect(encodeCalls.every((c) => c.quality === 0.82)).toBe(true);
    });

    it('preserves aspect ratio for non-square covers', async () => {
        installCanvasFakes({ bitmapHeight: 1000, bitmapWidth: 2000 });
        const src = makeBlob('image/jpeg');
        await downscaleToVariants(src, [{ px: 300, variant: 'itemCard' }], {
            format: 'webp',
            quality: 82,
        });
        // Longest edge clamped to 300 -> 300 x 150.
        expect(encodeCalls).toEqual([expect.objectContaining({ height: 150, width: 300 })]);
    });

    it('uses the source intrinsic size for px === 0 (original)', async () => {
        const src = makeBlob('image/jpeg');
        await downscaleToVariants(src, [{ px: 0, variant: 'fullScreen' }], {
            format: 'webp',
            quality: 82,
        });
        expect(encodeCalls).toEqual([
            expect.objectContaining({ height: SRC_HEIGHT, width: SRC_WIDTH }),
        ]);
    });

    it('never upscales: a target larger than the source clamps to the source', async () => {
        installCanvasFakes({ bitmapHeight: 200, bitmapWidth: 200 });
        const src = makeBlob('image/jpeg');
        await downscaleToVariants(src, [{ px: 300, variant: 'itemCard' }], {
            format: 'webp',
            quality: 82,
        });
        expect(encodeCalls).toEqual([expect.objectContaining({ height: 200, width: 200 })]);
    });

    it('emits image/jpeg when format is jpeg', async () => {
        const src = makeBlob('image/png');
        const result = await downscaleToVariants(src, [{ px: 80, variant: 'table' }], {
            format: 'jpeg',
            quality: 90,
        });
        expect(result.get('table')?.format).toBe('jpeg');
        expect(result.get('table')?.blob.type).toBe('image/jpeg');
        expect(encodeCalls[0].type).toBe('image/jpeg');
    });

    it('auto-falls back to jpeg when webp encoding is unsupported, logging once for the whole session', async () => {
        unsupportedMimes = new Set(['image/webp']);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const src = makeBlob('image/jpeg');

        // Multiple variants in one call, plus a second call, all fall back to
        // jpeg — but the webp-unsupported warning must fire exactly ONCE per
        // session, not once per variant (regression: 5 lines every launch).
        const result = await downscaleToVariants(
            src,
            [
                { px: 80, variant: 'table' },
                { px: 160, variant: 'itemCard' },
                { px: 320, variant: 'detail' },
            ],
            { format: 'webp', quality: 82 },
        );
        await downscaleToVariants(src, [{ px: 80, variant: 'table' }], {
            format: 'webp',
            quality: 82,
        });

        expect(result.get('table')?.format).toBe('jpeg');
        expect(result.get('table')?.blob.type).toBe('image/jpeg');
        expect(result.get('itemCard')?.format).toBe('jpeg');
        expect(result.get('detail')?.format).toBe('jpeg');

        const fallbackWarns = warn.mock.calls.filter(
            (c) => typeof c[0] === 'string' && c[0].includes('webp unsupported'),
        );
        expect(fallbackWarns).toHaveLength(1);
    });

    it('returns an empty map for an empty variant list', async () => {
        const src = makeBlob('image/jpeg');
        const result = await downscaleToVariants(src, [], { format: 'webp', quality: 82 });
        expect(result.size).toBe(0);
    });
});
