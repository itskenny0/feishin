import { useEffect, useRef } from 'react';

import styles from './trackmap-canvas.module.css';

import { useTrackmap } from '/@/renderer/features/trackmap/hooks/use-trackmap';
import { usePlayerSong, usePlayerStatus } from '/@/renderer/store/player.store';
import {
    type TrackmapAdvancedSettings,
    useTrackmapAdvanced,
    useTrackmapGlow,
    useTrackmapHeight,
    useTrackmapStyle,
} from '/@/renderer/store/settings.store';
import { subscribePlayerProgress, useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { PlayerStatus } from '/@/shared/types/types';

interface Rgb {
    b: number;
    g: number;
    r: number;
}

/**
 * Read the resolved theme accent (Mantine `--theme-colors-primary`) from
 * the document root. Falls back to a sane default if the variable is
 * missing — the trackmap should never silently render invisible.
 */
const readAccentColor = (): string => {
    const style = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null;
    const v = style?.getPropertyValue('--theme-colors-primary').trim();
    return v || '#22d3ee';
};

/**
 * Parse a CSS color string into RGB components. Handles `#rgb`, `#rrggbb`,
 * `rgb(r, g, b)`, and `rgba(r, g, b, a)`.
 */
const parseColor = (input: string): null | Rgb => {
    const s = input.trim();
    if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (hex.length === 3) {
            const r = parseInt(hex[0] + hex[0], 16);
            const g = parseInt(hex[1] + hex[1], 16);
            const b = parseInt(hex[2] + hex[2], 16);
            return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { b, g, r };
        }
        if (hex.length === 6) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b) ? null : { b, g, r };
        }
        return null;
    }
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) {
        return { b: Number(m[3]), g: Number(m[2]), r: Number(m[1]) };
    }
    return null;
};

/** Hard-coded fallbacks for when a user-configured color fails to parse. */
const FALLBACK_COOL: Rgb = { b: 246, g: 89, r: 155 }; // #9b59f6
const FALLBACK_BG_GLOW: Rgb = { b: 237, g: 58, r: 124 }; // #7c3aed
const FALLBACK_ACCENT: Rgb = { b: 238, g: 211, r: 34 }; // #22d3ee

const rgbStr = (c: Rgb, a?: number): string =>
    a === undefined ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

/**
 * Build a horizontal gradient whose color at each canvas position interpolates
 * between the cool anchor (low intensity) and a warm anchor (high intensity).
 *
 * Stops are placed uniformly along the canvas; the bin sampled at each stop
 * is shifted by `audioToCanvasRatio = metadataMs / decodedMs` so the
 * 256 bins (which span the *decoded* audio length, often longer than the
 * song's metadata duration because of transcode-introduced trailing
 * silence) end up at the canvas X corresponding to their actual song time
 * — not visibly frontrun the audio by several seconds.
 */
const buildEnergyGradient = (
    ctx: CanvasRenderingContext2D,
    w: number,
    bins: Float32Array,
    cool: Rgb,
    warm: Rgb,
    audioToCanvasRatio: number,
): CanvasGradient => {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    const n = bins.length;
    for (let i = 0; i < n; i += 1) {
        const canvasFrac = i / (n - 1);
        const scaled = canvasFrac * audioToCanvasRatio;
        let k: number;
        if (scaled <= 0) {
            k = bins[0];
        } else if (scaled >= 1) {
            k = bins[n - 1];
        } else {
            const f = scaled * (n - 1);
            const lo = Math.floor(f);
            const hi = Math.min(n - 1, lo + 1);
            const tt = f - lo;
            k = bins[lo] * (1 - tt) + bins[hi] * tt;
        }
        const r = Math.round(cool.r + (warm.r - cool.r) * k);
        const g = Math.round(cool.g + (warm.g - cool.g) * k);
        const b = Math.round(cool.b + (warm.b - cool.b) * k);
        grad.addColorStop(canvasFrac, `rgb(${r}, ${g}, ${b})`);
    }
    return grad;
};

/**
 * Draws the trackmap visualisation behind the seek slider. Every visual
 * knob lives in the settings store under `state.general.trackmap*`; this
 * component reads them via refs so changes apply on the next paint without
 * restarting the animation loop or re-mounting the canvas.
 *
 * Composition:
 *  1. Background ribbon glow (violet wash, vertical fade)
 *  2. Envelope-fill + outline (the DATA layer — per-bin energy gradient,
 *     mirrored above and below the slider centerline)
 *  3. Unplayed-side dim mask (destination-in alpha gradient)
 *  4. Playhead glow strip (additive blend)
 *
 * Motion (all gated on `prefers-reduced-motion`):
 *  - Amplitude breath (period + amplitude configurable)
 */
export const TrackmapCanvas = () => {
    const currentSong = usePlayerSong();
    const playerStatus = usePlayerStatus();
    const style = useTrackmapStyle();
    const height = useTrackmapHeight();
    const glow = useTrackmapGlow();
    const advanced = useTrackmapAdvanced();
    const { data } = useTrackmap(currentSong ?? null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const heightRef = useRef(height);
    const glowRef = useRef(glow);
    const dataRef = useRef(data);
    const styleRef = useRef(style);
    const advancedRef = useRef<TrackmapAdvancedSettings>(advanced);
    const songDurationMsRef = useRef<number>(0);
    const scheduleDrawRef = useRef<(() => void) | null>(null);
    /** Cursor X in canvas device pixels, or null when not hovering the
     *  playerbar. Drives the unplayed-side spotlight in the dim mask. */
    const cursorXRef = useRef<null | number>(null);
    /** Whether the canvas is currently intersecting the viewport. When the
     *  playerbar trackmap is scrolled/collapsed offscreen (e.g. the mobile
     *  fullscreen player canvas while the bar canvas is hidden, or vice
     *  versa) we pause the per-frame breath/interpolation redraw entirely —
     *  there's nothing to see, so the ~30fps canvas loop is pure waste. */
    const isVisibleRef = useRef(true);

    heightRef.current = height;
    glowRef.current = glow;
    dataRef.current = data;
    styleRef.current = style;
    advancedRef.current = advanced;
    songDurationMsRef.current = currentSong?.duration ?? 0;

    // Resize observer + DPR-change watcher.
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const sync = () => {
            const dpr = window.devicePixelRatio || 1;
            const rect = container.getBoundingClientRect();
            canvas.width = Math.max(1, Math.floor(rect.width * dpr));
            canvas.height = Math.max(1, Math.floor(rect.height * dpr));
            scheduleDrawRef.current?.();
        };

        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(container);

        // Also catch device-pixel-ratio changes that don't change CSS size
        // (window dragged to a Retina monitor).
        let mq: MediaQueryList | null = null;
        const armDprWatcher = () => {
            const dpr = window.devicePixelRatio || 1;
            mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
            mq.addEventListener('change', onDprChange);
        };
        function onDprChange() {
            mq?.removeEventListener('change', onDprChange);
            sync();
            armDprWatcher();
        }
        armDprWatcher();

        return () => {
            ro.disconnect();
            mq?.removeEventListener('change', onDprChange);
        };
    }, []);

    // Cursor tracking for the unplayed-side spotlight. The canvas itself has
    // pointer-events: none so the seek slider underneath receives clicks; we
    // attach the move/leave listeners to the slider-wrapper (the canvas
    // container's parent) which DOES receive events. mousemove translates
    // the cursor's clientX into canvas device pixels and stashes it in
    // cursorXRef; mouseleave clears it. Both schedule a redraw via the
    // existing rAF-deduped path so hovering with the mouse never causes
    // more than one paint per frame.
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        const sliderWrapper = container?.parentElement;
        if (!container || !canvas || !sliderWrapper) return;

        const handleMove = (e: MouseEvent) => {
            const rect = container.getBoundingClientRect();
            const xCss = e.clientX - rect.left;
            if (xCss < 0 || xCss > rect.width || rect.width <= 0) {
                if (cursorXRef.current !== null) {
                    cursorXRef.current = null;
                    scheduleDrawRef.current?.();
                }
                return;
            }
            cursorXRef.current = xCss * (canvas.width / rect.width);
            scheduleDrawRef.current?.();
        };
        const handleLeave = () => {
            if (cursorXRef.current !== null) {
                cursorXRef.current = null;
                scheduleDrawRef.current?.();
            }
        };

        sliderWrapper.addEventListener('mousemove', handleMove);
        sliderWrapper.addEventListener('mouseleave', handleLeave);

        return () => {
            sliderWrapper.removeEventListener('mousemove', handleMove);
            sliderWrapper.removeEventListener('mouseleave', handleLeave);
        };
    }, []);

    // Visibility gating. An IntersectionObserver flips isVisibleRef; while the
    // canvas is offscreen the draw loop stops re-arming its rAF (see the
    // `isAnimating && isVisibleRef.current` guard below), so a collapsed
    // fullscreen player or a scrolled-away playerbar costs nothing. When the
    // canvas scrolls back into view we schedule a single catch-up draw, which
    // re-arms the chain if playback is still animating.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || typeof IntersectionObserver === 'undefined') return;

        const io = new IntersectionObserver(
            (entries) => {
                const entry = entries[0];
                if (!entry) return;
                const wasVisible = isVisibleRef.current;
                isVisibleRef.current = entry.isIntersecting;
                if (entry.isIntersecting && !wasVisible) {
                    scheduleDrawRef.current?.();
                }
            },
            { threshold: 0 },
        );
        io.observe(canvas);

        return () => {
            io.disconnect();
        };
    }, []);

    // Draw loop. Every settings field is read off `advancedRef.current` so
    // settings tweaks apply on the next paint.
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return;

        const reducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const isAnimating = playerStatus === PlayerStatus.PLAYING && !reducedMotion;

        // Seed the playhead from the current store value so a re-run of this
        // effect (e.g. pause → playerStatus changes → effect re-runs) doesn't
        // momentarily snap the playhead back to the start before the first
        // progress event arrives. subscribePlayerProgress only fires on
        // change, not on subscribe.
        //
        // The audio engines all call setTimestamp(currentTime.toFixed(0)) on
        // a 500 ms setInterval, so progress events only fire on whole-second
        // boundaries. Between events we extrapolate by performance.now() so
        // the playhead moves at frame rate. No rounding compensation here —
        // the seek slider thumb reads the same (rounded) timestamp store, so
        // matching it visually is more important than matching the audio
        // engine's true sub-second position, which the user can't see.
        let progressTimestampMs = useTimestampStoreBase.getState().timestamp * 1000;
        let progressUpdatedAtMs = performance.now();
        let rafId: null | number = null;
        let unsub: (() => void) | null = null;

        // Per-frame caches. The energy gradient is a 256-stop horizontal
        // gradient whose stops depend ONLY on bins / canvas width / the two
        // anchor colors / the audio-to-canvas ratio — none of which change
        // between animation frames during playback (breath only scales the
        // vertical envelope, not the gradient). Rebuilding it every frame
        // costs a CanvasGradient allocation + 256 addColorStop calls on a
        // loop that runs at frame rate across up to three live canvases
        // (desktop playerbar + mobile playerbar + mobile fullscreen). Cache
        // it and rebuild only when one of its real inputs changes.
        let cachedEnergyGrad: CanvasGradient | null = null;
        let cachedGradKey = '';
        // readAccentColor() calls getComputedStyle(document.documentElement),
        // which forces a style recalc — too expensive to do every frame.
        // Cache it and refresh at most a few times per second; the theme
        // accent effectively never changes mid-playback.
        let cachedAccent = '';
        let cachedAccentAtMs = 0;
        const ACCENT_TTL_MS = 250;
        const getAccent = (nowMs: number): string => {
            if (!cachedAccent || nowMs - cachedAccentAtMs > ACCENT_TTL_MS) {
                cachedAccent = readAccentColor();
                cachedAccentAtMs = nowMs;
            }
            return cachedAccent;
        };

        // Throttle the animated redraw to ~30fps. The breath modulation and
        // the playhead interpolation are visually indistinguishable from the
        // native ~60Hz rAF cadence at 30fps (the playhead's minimum visible
        // step is one device pixel, and the breath period is measured in
        // seconds), but this halves the per-frame canvas work across the up to
        // three live trackmap canvases (desktop + mobile bar + mobile
        // fullscreen). One-off redraws (resize, cursor move, settings tweak,
        // progress event) bypass the throttle via the `forceDraw` flag.
        const FRAME_INTERVAL_MS = 1000 / 30;
        let lastDrawAtMs = 0;
        let forceDraw = false;

        const draw = () => {
            rafId = null;
            // Animated-frame throttle: when this draw was scheduled by the rAF
            // chain (not a one-off force), skip the actual paint if we're
            // still inside the frame budget, but keep the chain alive so the
            // next eligible frame lands on time.
            if (!forceDraw && isAnimating && isVisibleRef.current) {
                const sinceLast = performance.now() - lastDrawAtMs;
                if (sinceLast < FRAME_INTERVAL_MS) {
                    rafId = requestAnimationFrame(draw);
                    return;
                }
            }
            forceDraw = false;
            lastDrawAtMs = performance.now();
            const w = canvas.width;
            const h = canvas.height;
            ctx2d.clearRect(0, 0, w, h);

            const trackmap = dataRef.current;
            if (
                !trackmap ||
                styleRef.current !== 'glow' ||
                !trackmap.bins ||
                trackmap.bins.length < 2
            ) {
                if (isAnimating && isVisibleRef.current) rafId = requestAnimationFrame(draw);
                return;
            }

            const adv = advancedRef.current;
            const accent = getAccent(performance.now());
            // Warm anchor — user override has priority; empty string falls
            // back to the resolved theme accent. Same value drives the
            // playhead glow strip so the two read as one visual.
            const warmColor =
                (adv.colorWarm && parseColor(adv.colorWarm)) ||
                parseColor(accent) ||
                FALLBACK_ACCENT;
            const coolColor = parseColor(adv.colorCool) || FALLBACK_COOL;
            const bgGlowColor = parseColor(adv.colorBgGlow) || FALLBACK_BG_GLOW;

            const heightFactor = heightRef.current / 100;
            const glowFactor = glowRef.current / 100;
            const dpr = window.devicePixelRatio || 1;

            const now = isAnimating ? performance.now() : 0;
            const yCenter = h / 2;
            const baseHalfH = (h / 2) * heightFactor;
            const breathAmp = Math.max(0, Math.min(0.3, adv.breathAmplitudePct / 100));
            const breathPeriodMs = Math.max(500, adv.breathPeriodSec * 1000);
            const breath = 1 + breathAmp * Math.sin((now / breathPeriodMs) * Math.PI * 2);

            // Ambient idle pulse on the bg glow's alpha — a very slight
            // breathing of the violet wash, slower than the vertical breath
            // and phase-offset by 60° so the two modulations never lock
            // visually. Frozen to 1.0 when paused (`now` stays at 0).
            const ambientPulse =
                1 + 0.18 * Math.sin((now / (breathPeriodMs * 1.5)) * Math.PI * 2 + Math.PI / 3);
            // Clamp to yCenter so a wide height + amplified breath doesn't
            // clip to a flat top against the canvas edge — strands and
            // envelope alike just hit the lid instead of overflowing.
            const halfH = Math.min(yCenter, baseHalfH * breath);

            const bins = trackmap.bins;
            const binCount = bins.length;

            // The 256 intensity bins are computed over the DECODED audio's
            // duration (trackmap.durationMs), which often includes trailing
            // silence from the 64 kbps MP3 transcode used for analysis. The
            // canvas X axis represents the song's METADATA duration (what
            // the seek slider reports as max). Without scaling, bin N sits
            // at canvasFrac = N/binCount on a metadata timeline that is
            // shorter than the decoded one — every bin shows up earlier
            // than its audio actually plays, and the loud transient that
            // starts the song appears as a "misplaced glow" at the very
            // left edge of the canvas. Scale the bin index by
            // metadata/decoded so bin N lands at the canvas X corresponding
            // to its actual song time.
            const metadataMs =
                songDurationMsRef.current > 0 ? songDurationMsRef.current : trackmap.durationMs;
            const decodedMs = trackmap.durationMs > 0 ? trackmap.durationMs : metadataMs;
            const audioToCanvasRatio = decodedMs > 0 ? metadataMs / decodedMs : 1;

            const sampleBin = (xFrac: number): number => {
                const scaled = xFrac * audioToCanvasRatio;
                if (scaled <= 0) return bins[0];
                if (scaled >= 1) return bins[binCount - 1];
                const f = scaled * (binCount - 1);
                const lo = Math.floor(f);
                const hi = Math.min(binCount - 1, lo + 1);
                const t = f - lo;
                return bins[lo] * (1 - t) + bins[hi] * t;
            };

            const timelineMs = metadataMs;
            // While playing, drift the playhead by the wall-clock elapsed
            // since the last progress event so it advances smoothly between
            // the 1-Hz updates the audio engine emits. The clamp to
            // progressTimestampMs + 1100ms guards against runaway drift if
            // the engine ever skips an update — the playhead stalls instead
            // of overshooting the actual playback position.
            const wallElapsed = isAnimating
                ? Math.min(1100, Math.max(0, performance.now() - progressUpdatedAtMs))
                : 0;
            const effectivePlayheadMs = progressTimestampMs + wallElapsed;
            const playheadFrac =
                timelineMs > 0 ? Math.min(1, Math.max(0, effectivePlayheadMs / timelineMs)) : 0;
            // Align with the slider's BAR right edge — that's the visible
            // "current position" marker because the playerbar's thumb has
            // opacity: 0 until hover (see playerbar-slider.module.css).
            //
            // Mantine renders the bar as:
            //   width:               position% + 2 * var(--slider-size)
            //   inset-inline-start:  -var(--slider-size)
            // inside the Track, which itself starts at +var(--slider-size)
            // due to the slider root's padding-inline. Net: the bar's right
            // edge in slider-wrapper coordinates is
            //   12px + frac * (root_width - 12px)
            // where 12 = 2 * --slider-size and --slider-size = 6 CSS px for
            // the playerbar's size={6}. Match that exactly. Keep
            // SLIDER_SIZE_CSS_PX in sync with the size prop passed to
            // CustomPlayerbarSlider in playerbar-slider.tsx.
            const SLIDER_SIZE_CSS_PX = 6;
            const insetPx = 2 * SLIDER_SIZE_CSS_PX * dpr;
            const playheadX = insetPx + playheadFrac * Math.max(0, w - insetPx);

            // === Pass 1: background ribbon glow =============================
            {
                const a = Math.min(1, Math.max(0, (adv.bgGlowAlpha / 100) * ambientPulse));
                if (a > 0) {
                    const bgGrad = ctx2d.createLinearGradient(
                        0,
                        yCenter - halfH,
                        0,
                        yCenter + halfH,
                    );
                    bgGrad.addColorStop(0, rgbStr(bgGlowColor, 0));
                    bgGrad.addColorStop(0.5, rgbStr(bgGlowColor, a));
                    bgGrad.addColorStop(1, rgbStr(bgGlowColor, 0));
                    ctx2d.save();
                    ctx2d.fillStyle = bgGrad;
                    ctx2d.fillRect(0, 0, w, h);
                    ctx2d.restore();
                }
            }

            // === Pass 2: envelope fill + outline ============================
            {
                const stepEnv = Math.max(1, Math.floor(dpr));
                // Rebuild the energy gradient only when one of its inputs
                // actually changes — see the cache declarations above the
                // draw loop. The key folds every parameter buildEnergyGradient
                // reads (bins length stands in for bins identity, which is
                // stable per analysis result; a new song re-runs the effect
                // and resets the cache).
                const gradKey = `${w}|${binCount}|${rgbStr(coolColor)}|${rgbStr(warmColor)}|${audioToCanvasRatio.toFixed(4)}`;
                if (!cachedEnergyGrad || gradKey !== cachedGradKey) {
                    cachedEnergyGrad = buildEnergyGradient(
                        ctx2d,
                        w,
                        bins,
                        coolColor,
                        warmColor,
                        audioToCanvasRatio,
                    );
                    cachedGradKey = gradKey;
                }
                const energyGrad = cachedEnergyGrad;
                ctx2d.beginPath();
                for (let px = 0; px <= w; px += stepEnv) {
                    const xFrac = px / w;
                    const intensity = sampleBin(xFrac);
                    const y = yCenter - intensity * halfH;
                    if (px === 0) ctx2d.moveTo(px, y);
                    else ctx2d.lineTo(px, y);
                }
                for (let px = w; px >= 0; px -= stepEnv) {
                    const xFrac = px / w;
                    const intensity = sampleBin(xFrac);
                    const y = yCenter + intensity * halfH;
                    ctx2d.lineTo(px, y);
                }
                ctx2d.closePath();

                const fillA = adv.envelopeFillAlpha / 100;
                if (fillA > 0) {
                    ctx2d.save();
                    ctx2d.fillStyle = energyGrad;
                    ctx2d.globalAlpha = fillA;
                    ctx2d.fill();
                    ctx2d.restore();
                }
                const outlineA = adv.envelopeOutlineAlpha / 100;
                const outlineW = adv.envelopeOutlineWidthPx * dpr;
                if (outlineA > 0 && outlineW > 0) {
                    ctx2d.save();
                    ctx2d.strokeStyle = energyGrad;
                    ctx2d.globalAlpha = outlineA;
                    ctx2d.lineWidth = Math.max(1, outlineW);
                    ctx2d.lineJoin = 'round';
                    ctx2d.stroke();
                    ctx2d.restore();
                }
            }

            // === Pass 3: unplayed dim mask ==================================
            //
            // One full-width horizontal gradient drives the whole mask so the
            // played side, the soft fade across the playhead, AND the
            // cursor-hover spotlight on the unplayed side all share a single
            // destination-in source. (Doing it as separate fillRects with
            // destination-in would erase the canvas everywhere the source
            // doesn't cover — destination-in keeps dest only where the
            // source has alpha.)
            //
            // The spotlight is a triangular dim→full→dim peak centered on
            // cursorXRef, only added when the cursor is on the unplayed
            // side. createLinearGradient extrapolates outside its line, so
            // the leading 0 / trailing 1 anchors keep the played and far-
            // unplayed regions at their resolved alpha even when the spot
            // stops sit far inside the canvas.
            {
                const dimMin = Math.max(0, Math.min(1, adv.dimMaskMin / 100));
                const transition = Math.max(0, adv.dimMaskTransitionPx * dpr);
                const fullAlpha = 'rgba(0,0,0,1)';
                const dimAlpha = `rgba(0,0,0,${dimMin})`;

                ctx2d.save();
                ctx2d.globalCompositeOperation = 'destination-in';

                const dimGrad = ctx2d.createLinearGradient(0, 0, w, 0);
                const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
                // Played region — full alpha all the way up to the playhead.
                dimGrad.addColorStop(0, fullAlpha);
                const playheadFrac01 = clamp01(playheadX / w);
                const transitionEndFrac = clamp01((playheadX + transition) / w);
                if (transition > 0) {
                    if (playheadFrac01 > 0) dimGrad.addColorStop(playheadFrac01, fullAlpha);
                    if (transitionEndFrac > playheadFrac01)
                        dimGrad.addColorStop(transitionEndFrac, dimAlpha);
                } else if (playheadFrac01 > 0 && playheadFrac01 < 1) {
                    // Hard edge: jump straight from full to dim at the
                    // playhead. CanvasGradient needs strictly-increasing
                    // offsets, so nudge the second stop by an epsilon.
                    dimGrad.addColorStop(playheadFrac01, fullAlpha);
                    dimGrad.addColorStop(Math.min(1, playheadFrac01 + 0.0001), dimAlpha);
                }

                // Cursor spotlight on the unplayed side. Triangular alpha
                // peak from dimMin → 1 → dimMin over [cursor - r, cursor + r].
                // Skipped if the cursor isn't past the dim transition or
                // there's no room left in the gradient.
                const cursorX = cursorXRef.current;
                const SPOT_RADIUS_CSS_PX = 70;
                if (cursorX !== null && cursorX > playheadX + transition && cursorX < w) {
                    const radius = SPOT_RADIUS_CSS_PX * dpr;
                    const cursorFrac = clamp01(cursorX / w);
                    const safeStart = Math.max(
                        transitionEndFrac + 0.0001,
                        clamp01((cursorX - radius) / w),
                    );
                    const safeEnd = clamp01((cursorX + radius) / w);
                    if (safeStart < cursorFrac && cursorFrac < 1) {
                        dimGrad.addColorStop(safeStart, dimAlpha);
                        dimGrad.addColorStop(cursorFrac, fullAlpha);
                        if (safeEnd > cursorFrac && safeEnd < 1) {
                            dimGrad.addColorStop(safeEnd, dimAlpha);
                        }
                    }
                }

                // Trailing anchor — far-unplayed stays at dimMin.
                dimGrad.addColorStop(1, dimAlpha);

                ctx2d.fillStyle = dimGrad;
                ctx2d.fillRect(0, 0, w, h);
                ctx2d.restore();
            }

            // === Pass 4: playhead glow strip ================================
            if (!reducedMotion && glowFactor > 0) {
                const phA = (adv.playheadGlowAlpha / 100) * glowFactor;
                if (phA > 0) {
                    ctx2d.save();
                    ctx2d.globalCompositeOperation = 'lighter';
                    ctx2d.fillStyle = rgbStr(warmColor, phA);
                    ctx2d.shadowColor = rgbStr(warmColor);
                    ctx2d.shadowBlur = adv.playheadShadowBlurPx * glowFactor * dpr;
                    const phWidth = Math.max(2, adv.playheadWidthPx * dpr);
                    ctx2d.fillRect(playheadX - phWidth / 2, 0, phWidth, h);
                    ctx2d.restore();
                }
            }

            // Chain the rAF while playing (and visible) so the breath
            // modulation and the smooth playhead interpolation stay fluid. The
            // chain stops re-arming while offscreen — the IntersectionObserver
            // schedules a catch-up draw when the canvas returns to view.
            if (isAnimating && isVisibleRef.current) {
                rafId = requestAnimationFrame(draw);
            }
        };

        // Schedule a single immediate (throttle-bypassing) draw — used for
        // resize, cursor moves, settings tweaks, progress events, and the
        // visibility catch-up. Distinct from the rAF chain's throttled frames.
        const schedule = () => {
            forceDraw = true;
            if (rafId !== null) return;
            rafId = requestAnimationFrame(draw);
        };
        scheduleDrawRef.current = schedule;

        schedule();

        unsub = subscribePlayerProgress(({ timestamp }) => {
            progressTimestampMs = timestamp * 1000;
            progressUpdatedAtMs = performance.now();
            schedule();
        });

        return () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
            unsub?.();
            scheduleDrawRef.current = null;
        };
    }, [data, glow, height, playerStatus, style, currentSong?.id]);

    // Settings live-preview: whenever any advanced knob changes, schedule
    // a single redraw. The main rAF chain only re-arms while playing, and
    // subscribePlayerProgress only fires on timestamp change — without this
    // effect, tweaking sliders while paused would leave the trackmap stale
    // until the user pressed play again.
    useEffect(() => {
        scheduleDrawRef.current?.();
    }, [advanced]);

    return (
        // aria-hidden: the trackmap is purely decorative — the seek slider
        // it sits behind is the actual interactive control screen readers
        // should reach.
        <div aria-hidden="true" className={styles.container} ref={containerRef}>
            <canvas className={styles.canvas} ref={canvasRef} />
        </div>
    );
};
