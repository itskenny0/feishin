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
import { subscribePlayerProgress } from '/@/renderer/store/timestamp.store';
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
const FALLBACK_STRAND_B: Rgb = { b: 182, g: 114, r: 244 }; // #f472b6
const FALLBACK_COOL: Rgb = { b: 246, g: 89, r: 155 }; // #9b59f6
const FALLBACK_BG_GLOW: Rgb = { b: 237, g: 58, r: 124 }; // #7c3aed
const FALLBACK_ACCENT: Rgb = { b: 238, g: 211, r: 34 }; // #22d3ee

const rgbStr = (c: Rgb, a?: number): string =>
    a === undefined ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

/**
 * Build a horizontal gradient whose color at each bin position interpolates
 * between the cool anchor (low intensity) and a warm anchor (high
 * intensity) using `bins[i]` as the weight.
 */
const buildEnergyGradient = (
    ctx: CanvasRenderingContext2D,
    w: number,
    bins: Float32Array,
    cool: Rgb,
    warm: Rgb,
): CanvasGradient => {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    const n = bins.length;
    for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1);
        const k = bins[i];
        const r = Math.round(cool.r + (warm.r - cool.r) * k);
        const g = Math.round(cool.g + (warm.g - cool.g) * k);
        const b = Math.round(cool.b + (warm.b - cool.b) * k);
        grad.addColorStop(t, `rgb(${r}, ${g}, ${b})`);
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
 *  2. Envelope-fill + outline (the DATA layer — per-bin energy gradient)
 *  3. DNA base-pair rungs (vertical connectors between the two strands)
 *  4. Strand halos (additive blend, blurred shadow)
 *  5. Crisp strand lines (additive blend, no shadow)
 *  6. Unplayed-side dim mask (destination-in alpha gradient)
 *  7. Playhead glow strip (additive blend)
 *
 * Motion (all gated on `prefers-reduced-motion`):
 *  - Helix rotation (period configurable via trackmapHelixRotationSec;
 *    0 = static, which is the default per recent user feedback)
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

        let lastPlayheadMs = 0;
        let rafId: null | number = null;
        let unsub: (() => void) | null = null;

        const draw = () => {
            rafId = null;
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
                if (isAnimating) rafId = requestAnimationFrame(draw);
                return;
            }

            const adv = advancedRef.current;
            const accent = readAccentColor();
            // Strand A — user override has priority; empty string falls back
            // to the resolved theme accent.
            const strandA =
                (adv.colorWarm && parseColor(adv.colorWarm)) ||
                parseColor(accent) ||
                FALLBACK_ACCENT;
            const strandB = parseColor(adv.colorStrandB) || FALLBACK_STRAND_B;
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
            const halfH = baseHalfH * breath;

            const helixCycles = Math.max(1, adv.helixCycles);
            // helixRotationSec = 0 ⇒ static (rot stays 0).
            const rot =
                adv.helixRotationSec > 0 ? (now * Math.PI * 2) / (adv.helixRotationSec * 1000) : 0;

            const bins = trackmap.bins;
            const binCount = bins.length;

            const sampleBin = (xFrac: number): number => {
                const f = xFrac * (binCount - 1);
                const lo = Math.floor(f);
                const hi = Math.min(binCount - 1, lo + 1);
                const t = f - lo;
                return bins[lo] * (1 - t) + bins[hi] * t;
            };

            const phaseAt = (xFrac: number): number => xFrac * Math.PI * 2 * helixCycles - rot;

            const timelineMs =
                songDurationMsRef.current > 0 ? songDurationMsRef.current : trackmap.durationMs;
            const playheadFrac =
                timelineMs > 0 ? Math.min(1, Math.max(0, lastPlayheadMs / timelineMs)) : 0;
            const playheadX = playheadFrac * w;

            // === Pass 1: background ribbon glow =============================
            {
                const a = adv.bgGlowAlpha / 100;
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
                const energyGrad = buildEnergyGradient(ctx2d, w, bins, coolColor, strandA);
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

            // === Pass 3: DNA base-pair rungs ================================
            {
                const rungA = adv.rungAlpha / 100;
                if (rungA > 0) {
                    const rungSpacing = Math.max(2, adv.rungSpacingPx * dpr);
                    ctx2d.save();
                    ctx2d.lineCap = 'round';
                    ctx2d.lineWidth = Math.max(1, 1.2 * dpr);
                    for (let xR = 0; xR <= w; xR += rungSpacing) {
                        const xFrac = xR / w;
                        const intensity = sampleBin(xFrac);
                        const cosphi = Math.cos(phaseAt(xFrac));
                        const envelope = intensity * halfH;
                        const yA = yCenter - envelope * cosphi;
                        const yB = yCenter + envelope * cosphi;
                        const visibility = Math.abs(cosphi);
                        if (visibility < 0.15) continue;
                        ctx2d.strokeStyle = rgbStr(strandB, rungA * visibility);
                        ctx2d.beginPath();
                        ctx2d.moveTo(xR, yA);
                        ctx2d.lineTo(xR, yB);
                        ctx2d.stroke();
                    }
                    ctx2d.restore();
                }
            }

            // === Strand path helper =========================================
            const step = Math.max(1, Math.floor(dpr));
            const drawStrandPath = (sign: -1 | 1) => {
                ctx2d.beginPath();
                let started = false;
                for (let px = 0; px <= w; px += step) {
                    const xFrac = px / w;
                    const intensity = sampleBin(xFrac);
                    const cosphi = Math.cos(phaseAt(xFrac));
                    const envelope = intensity * halfH;
                    const y = yCenter + sign * envelope * cosphi;
                    if (!started) {
                        ctx2d.moveTo(px, y);
                        started = true;
                    } else {
                        ctx2d.lineTo(px, y);
                    }
                }
            };

            // === Pass 4: strand halos =======================================
            if (!reducedMotion && glowFactor > 0) {
                const haloA = (adv.strandHaloAlpha / 100) * glowFactor;
                if (haloA > 0) {
                    ctx2d.save();
                    ctx2d.globalCompositeOperation = 'lighter';
                    ctx2d.lineCap = 'round';
                    ctx2d.lineJoin = 'round';
                    ctx2d.lineWidth = Math.max(2, 2.4 * dpr);
                    ctx2d.shadowBlur = adv.haloBlurPx * glowFactor;

                    ctx2d.strokeStyle = rgbStr(strandA, haloA);
                    ctx2d.shadowColor = rgbStr(strandA);
                    drawStrandPath(-1);
                    ctx2d.stroke();

                    ctx2d.strokeStyle = rgbStr(strandB, haloA);
                    ctx2d.shadowColor = rgbStr(strandB);
                    drawStrandPath(1);
                    ctx2d.stroke();

                    ctx2d.restore();
                }
            }

            // === Pass 5: crisp strands ======================================
            {
                const crispA = adv.strandCrispAlpha / 100;
                if (crispA > 0) {
                    ctx2d.save();
                    ctx2d.globalCompositeOperation = 'lighter';
                    ctx2d.lineCap = 'round';
                    ctx2d.lineJoin = 'round';
                    ctx2d.lineWidth = Math.max(1.5, 1.8 * dpr);
                    ctx2d.shadowBlur = 0;

                    ctx2d.strokeStyle = rgbStr(strandA, crispA);
                    drawStrandPath(-1);
                    ctx2d.stroke();

                    ctx2d.strokeStyle = rgbStr(strandB, crispA);
                    drawStrandPath(1);
                    ctx2d.stroke();

                    ctx2d.restore();
                }
            }

            // === Pass 6: unplayed dim mask ==================================
            {
                const dimMin = Math.max(0, Math.min(1, adv.dimMaskMin / 100));
                const transition = Math.max(0, adv.dimMaskTransitionPx * dpr);
                ctx2d.save();
                ctx2d.globalCompositeOperation = 'destination-in';
                if (transition <= 0) {
                    // Hard edge: opaque on the played side, dimMin on the unplayed.
                    ctx2d.fillStyle = 'rgba(0,0,0,1)';
                    ctx2d.fillRect(0, 0, playheadX, h);
                    ctx2d.fillStyle = `rgba(0,0,0,${dimMin})`;
                    ctx2d.fillRect(playheadX, 0, w - playheadX, h);
                } else {
                    const dimGrad = ctx2d.createLinearGradient(
                        playheadX,
                        0,
                        playheadX + transition,
                        0,
                    );
                    dimGrad.addColorStop(0, 'rgba(0,0,0,1)');
                    dimGrad.addColorStop(1, `rgba(0,0,0,${dimMin})`);
                    ctx2d.fillStyle = dimGrad;
                    ctx2d.fillRect(0, 0, w, h);
                }
                ctx2d.restore();
            }

            // === Pass 7: playhead glow strip ================================
            if (!reducedMotion && glowFactor > 0) {
                const phA = (adv.playheadGlowAlpha / 100) * glowFactor;
                if (phA > 0) {
                    ctx2d.save();
                    ctx2d.globalCompositeOperation = 'lighter';
                    ctx2d.fillStyle = rgbStr(strandA, phA);
                    ctx2d.shadowColor = rgbStr(strandA);
                    ctx2d.shadowBlur = adv.playheadShadowBlurPx * glowFactor;
                    const phWidth = Math.max(2, adv.playheadWidthPx * dpr);
                    ctx2d.fillRect(playheadX - phWidth / 2, 0, phWidth, h);
                    ctx2d.restore();
                }
            }

            // Chain the rAF while animating. We also chain if the helix is
            // configured with non-zero rotation OR the breath amplitude is
            // non-zero AND the player is playing — both depend on `now`
            // advancing for visual change.
            if (isAnimating) {
                rafId = requestAnimationFrame(draw);
            }
        };

        const schedule = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(draw);
        };
        scheduleDrawRef.current = schedule;

        schedule();

        unsub = subscribePlayerProgress(({ timestamp }) => {
            lastPlayheadMs = timestamp * 1000;
            schedule();
        });

        return () => {
            if (rafId !== null) cancelAnimationFrame(rafId);
            unsub?.();
            scheduleDrawRef.current = null;
        };
    }, [data, glow, height, playerStatus, style, currentSong?.id]);

    return (
        <div className={styles.container} ref={containerRef}>
            <canvas className={styles.canvas} ref={canvasRef} />
        </div>
    );
};
