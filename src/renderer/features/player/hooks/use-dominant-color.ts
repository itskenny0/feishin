import { useEffect, useRef, useState } from 'react';

// Bounded, insertion-order LRU keyed by album-art URL. This is a render
// optimization for the now-playing hero gradient, not a correctness
// store, so a small cap is ample and eviction merely re-extracts a color
// once. Capping stops the map from growing for every distinct cover
// played across a long session.
const MAX_DOMINANT_COLOR_ENTRIES = 500;
const colorMap = new Map<string, null | string>();

// Transient load failures (art server 5xx / network blip) are NOT cached as a
// permanent null — unlike a CORS taint or an empty cover, the image can become
// reachable later. We record a short cooldown instead so the gradient retries
// on the next view past the TTL rather than staying suppressed all session.
const NEGATIVE_RETRY_MS = 30_000;
const MAX_TRANSIENT_FAIL_ENTRIES = 200;
const transientFailAt = new Map<string, number>();

const recordTransientFail = (url: string, now: number): void => {
    if (transientFailAt.has(url)) {
        transientFailAt.delete(url);
    } else if (transientFailAt.size >= MAX_TRANSIENT_FAIL_ENTRIES) {
        const oldest = transientFailAt.keys().next().value;
        if (oldest !== undefined) transientFailAt.delete(oldest);
    }
    transientFailAt.set(url, now);
};

const cache = {
    get(url: string): null | string | undefined {
        return colorMap.get(url);
    },
    has(url: string): boolean {
        return colorMap.has(url);
    },
    set(url: string, value: null | string): void {
        if (colorMap.has(url)) {
            colorMap.delete(url);
        } else if (colorMap.size >= MAX_DOMINANT_COLOR_ENTRIES) {
            const oldest = colorMap.keys().next().value;
            if (oldest !== undefined) colorMap.delete(oldest);
        }
        colorMap.set(url, value);
    },
};

interface UseDominantColorResult {
    color: null | string;
}

/**
 * Loads the image at `url` into an offscreen canvas and computes a single
 * "dominant-ish" color by downsampling + averaging a small grid of pixels,
 * with near-white and near-black filtered out so a dark/light album-art
 * background doesn't dominate the result. Returns the color as an
 * `rgb(r, g, b)` string, or null if the canvas read fails (CORS) or the
 * image fails to load.
 *
 * Memoized in-process by URL so song repeats don't re-extract.
 */
export const useDominantColor = (url?: null | string): UseDominantColorResult => {
    const [color, setColor] = useState<null | string>(() =>
        url ? (cache.get(url) ?? null) : null,
    );
    const lastUrlRef = useRef<null | string>(null);

    useEffect(() => {
        if (!url) {
            setColor(null);
            return;
        }
        if (cache.has(url)) {
            setColor(cache.get(url) ?? null);
            return;
        }
        // Honour an in-cooldown transient failure; once it ages out, retry.
        const failedAt = transientFailAt.get(url);
        if (failedAt !== undefined) {
            if (Date.now() - failedAt < NEGATIVE_RETRY_MS) {
                setColor(null);
                return;
            }
            transientFailAt.delete(url);
        }
        if (lastUrlRef.current === url) return;
        lastUrlRef.current = url;

        let cancelled = false;
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';

        img.onload = () => {
            if (cancelled) return;
            try {
                const w = 48;
                const h = 48;
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                    cache.set(url, null);
                    return;
                }
                ctx.drawImage(img, 0, 0, w, h);
                const data = ctx.getImageData(0, 0, w, h).data;
                let r = 0;
                let g = 0;
                let b = 0;
                let count = 0;
                for (let i = 0; i < data.length; i += 4) {
                    const pr = data[i];
                    const pg = data[i + 1];
                    const pb = data[i + 2];
                    // Filter out near-white and near-black so the
                    // "average" leans toward the album's actual hue.
                    const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
                    if (lum < 20 || lum > 235) continue;
                    // Filter out near-grey so a sepia background doesn't
                    // dominate the average — only count pixels with some
                    // saturation.
                    const maxC = Math.max(pr, pg, pb);
                    const minC = Math.min(pr, pg, pb);
                    if (maxC - minC < 18) continue;
                    r += pr;
                    g += pg;
                    b += pb;
                    count += 1;
                }
                if (count === 0) {
                    cache.set(url, null);
                    if (!cancelled) setColor(null);
                    return;
                }
                const avg = `rgb(${Math.round(r / count)}, ${Math.round(g / count)}, ${Math.round(b / count)})`;
                cache.set(url, avg);
                if (!cancelled) setColor(avg);
            } catch {
                // Tainted canvas (CORS) or other read error. Cache null so
                // we don't retry.
                cache.set(url, null);
                if (!cancelled) setColor(null);
            }
        };
        img.onerror = () => {
            // Don't poison the permanent cache — the cover may load later.
            // Record a cooldown and clear lastUrlRef so a re-render past the
            // TTL can re-attempt extraction.
            recordTransientFail(url, Date.now());
            lastUrlRef.current = null;
            if (!cancelled) setColor(null);
        };
        img.src = url;

        return () => {
            cancelled = true;
        };
    }, [url]);

    return { color };
};
