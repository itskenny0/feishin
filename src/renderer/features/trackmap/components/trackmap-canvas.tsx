import { useEffect, useRef } from 'react';

import styles from './trackmap-canvas.module.css';

import { useTrackmap } from '/@/renderer/features/trackmap/hooks/use-trackmap';
import { usePlayerSong, usePlayerStatus } from '/@/renderer/store/player.store';
import {
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
    return v || '#4dabf7';
};

/** Cool / "slow" color anchor for the low-intensity end of the energy ramp. */
const COOL_COLOR: Rgb = { b: 246, g: 89, r: 155 }; // ≈ #9b59f6 — soft purple

/**
 * Parse a CSS color string into RGB components. Handles `#rgb`, `#rrggbb`,
 * `rgb(r, g, b)`, and `rgba(r, g, b, a)` — the forms Mantine themes resolve
 * to in practice. Returns `null` if the string isn't recognised so the
 * caller can fall back to a sane default.
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

/**
 * Build a horizontal gradient whose color at bin position `i` interpolates
 * between the cool (low-intensity) anchor and the theme accent (high-
 * intensity) using `bins[i]` as the interpolation weight. The resulting
 * gradient gives every part of the wave its own color reading the local
 * intensity — slow / quiet sections read purple, energetic peaks read
 * the theme accent.
 */
const buildEnergyGradient = (
    ctx: CanvasRenderingContext2D,
    w: number,
    bins: Float32Array,
    warm: Rgb,
): CanvasGradient => {
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    const n = bins.length;
    for (let i = 0; i < n; i += 1) {
        const t = i / (n - 1);
        const k = bins[i];
        const r = Math.round(COOL_COLOR.r + (warm.r - COOL_COLOR.r) * k);
        const g = Math.round(COOL_COLOR.g + (warm.g - COOL_COLOR.g) * k);
        const b = Math.round(COOL_COLOR.b + (warm.b - COOL_COLOR.b) * k);
        grad.addColorStop(t, `rgb(${r}, ${g}, ${b})`);
    }
    return grad;
};

/**
 * Draws the glow-wave trackmap. Subscribes to:
 *  - useTrackmap(currentSong) for the bins.
 *  - The timestamp store for the playhead position (without re-rendering React).
 *  - ResizeObserver on the wrapper for device-pixel-ratio handling.
 *  - prefers-reduced-motion to disable the halo, shimmer, and breath.
 *
 * The wave is mirrored around the canvas's vertical centerline so the slider
 * track sits inside a "ribbon" of intensity rather than under a thin line.
 * While playing, a continuous rAF loop drives two slow idle animations:
 *  - Breath: amplitude scales by ±5% over a 6 s period.
 *  - Shimmer: a soft brightness band travels left-to-right across the
 *    played portion, period 4.5 s, restricted to existing waveform pixels.
 */
export const TrackmapCanvas = () => {
    const currentSong = usePlayerSong();
    const playerStatus = usePlayerStatus();
    const style = useTrackmapStyle();
    const height = useTrackmapHeight();
    const glow = useTrackmapGlow();
    const { data } = useTrackmap(currentSong ?? null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const heightRef = useRef(height);
    const glowRef = useRef(glow);
    const dataRef = useRef(data);
    const styleRef = useRef(style);
    // Shared "schedule a redraw" handle — populated by the draw-loop effect,
    // called by the resize observer so a window resize (which clears the
    // canvas backing store) immediately triggers a repaint instead of
    // leaving the canvas blank until the next playback tick.
    const scheduleDrawRef = useRef<(() => void) | null>(null);

    heightRef.current = height;
    glowRef.current = glow;
    dataRef.current = data;
    styleRef.current = style;

    // Resize observer — keep the backing-store size in sync with CSS size * DPR.
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const sync = () => {
            const dpr = window.devicePixelRatio || 1;
            const rect = container.getBoundingClientRect();
            canvas.width = Math.max(1, Math.floor(rect.width * dpr));
            canvas.height = Math.max(1, Math.floor(rect.height * dpr));
            // Setting width/height clears the canvas; ask the draw loop to
            // repaint so the user doesn't see a blank slot until the next
            // playback tick (matters when paused).
            scheduleDrawRef.current?.();
        };

        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(container);
        return () => ro.disconnect();
    }, []);

    // Draw loop — runs continuously while playing (so the breath + shimmer
    // animations have something to advance on), and on-demand when paused.
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
            if (!trackmap || styleRef.current !== 'glow') {
                // Keep the rAF chain alive while playing so we pick up the
                // moment data finally arrives without a manual nudge.
                if (isAnimating) rafId = requestAnimationFrame(draw);
                return;
            }

            const accent = readAccentColor();
            const accentRgb = parseColor(accent) ?? { b: 247, g: 171, r: 77 }; // #4dabf7
            const heightFactor = heightRef.current / 100;
            const glowFactor = glowRef.current / 100;
            const dpr = window.devicePixelRatio || 1;

            // Idle animation phases. `now = 0` while paused/reduced-motion ⇒
            // breath sin = 0 ⇒ amplitude 1.0 ⇒ static.
            const now = isAnimating ? performance.now() : 0;
            const breath = 1 + 0.05 * Math.sin((now / 6000) * Math.PI * 2);

            const yCenter = h / 2;
            const halfH = (h / 2) * heightFactor * breath;

            const bins = trackmap.bins;
            const binCount = bins.length;

            // Per-bin energy gradient — cool purple at quiet sections, theme
            // accent at peaks. Shared by the fill (pass 1) and crisp-line
            // (pass 3) passes; the halo and playhead keep solid accent so the
            // shadow blur stays uniform.
            const energyGrad = buildEnergyGradient(ctx2d, w, bins, accentRgb);

            // Trace the upper (sign = -1) or lower (sign = +1) polyline as a
            // stroke path. Avoids allocating a points array per frame.
            const tracePolyline = (sign: -1 | 1) => {
                ctx2d.beginPath();
                for (let i = 0; i < binCount; i += 1) {
                    const x = (i / (binCount - 1)) * w;
                    const y = yCenter + sign * bins[i] * halfH;
                    if (i === 0) ctx2d.moveTo(x, y);
                    else ctx2d.lineTo(x, y);
                }
            };

            // Trace a closed shape (polyline + back along centerline) for
            // the fill pass.
            const traceFilled = (sign: -1 | 1) => {
                ctx2d.beginPath();
                ctx2d.moveTo(0, yCenter);
                for (let i = 0; i < binCount; i += 1) {
                    const x = (i / (binCount - 1)) * w;
                    const y = yCenter + sign * bins[i] * halfH;
                    ctx2d.lineTo(x, y);
                }
                ctx2d.lineTo(w, yCenter);
                ctx2d.closePath();
            };

            // Pass 1: filled wash — both halves filled from centerline outward,
            // colored by the per-bin energy gradient. Solid visual mass rather
            // than just a thin line, plus a spatial mood-reading of the song:
            // quiet sections render purple, peaks render the theme accent.
            ctx2d.save();
            ctx2d.fillStyle = energyGrad;
            ctx2d.globalAlpha = 0.32;
            traceFilled(-1);
            ctx2d.fill();
            traceFilled(1);
            ctx2d.fill();
            ctx2d.restore();

            // Pass 2: soft halo stroke (skipped under prefers-reduced-motion
            // or when glow = 0).
            if (!reducedMotion && glowFactor > 0) {
                ctx2d.save();
                ctx2d.strokeStyle = accent;
                ctx2d.lineWidth = 2;
                ctx2d.globalAlpha = 0.55 * glowFactor;
                ctx2d.shadowColor = accent;
                ctx2d.shadowBlur = 14 * glowFactor;
                tracePolyline(-1);
                ctx2d.stroke();
                tracePolyline(1);
                ctx2d.stroke();
                ctx2d.restore();
            }

            // Pass 3: crisp line on top of the halo, using the energy gradient
            // so the line itself reads the song's mood as it traverses x.
            ctx2d.save();
            ctx2d.strokeStyle = energyGrad;
            ctx2d.lineWidth = Math.max(1.25, dpr * 1.5);
            ctx2d.globalAlpha = 1;
            ctx2d.shadowBlur = 0;
            tracePolyline(-1);
            ctx2d.stroke();
            tracePolyline(1);
            ctx2d.stroke();
            ctx2d.restore();

            // Playhead position — used by passes 4–6.
            const playheadFrac =
                trackmap.durationMs > 0
                    ? Math.min(1, Math.max(0, lastPlayheadMs / trackmap.durationMs))
                    : 0;
            const playheadX = playheadFrac * w;

            // Pass 4: shimmer — a soft brightness band traveling left-to-right
            // along the played portion. `source-atop` restricts it to existing
            // waveform pixels so the band reads as the curve glowing rather
            // than a white slab.
            if (isAnimating && playheadX > 4) {
                const shimmerPhase = (((now / 4500) % 1) + 1) % 1;
                const shimmerWidth = Math.max(40, w * 0.18);
                // Travel from -shimmerWidth to playheadX + shimmerWidth so the
                // band enters and exits the played zone gradually.
                const shimmerCenter = -shimmerWidth + shimmerPhase * (playheadX + 2 * shimmerWidth);
                ctx2d.save();
                ctx2d.globalCompositeOperation = 'source-atop';
                const grad = ctx2d.createLinearGradient(
                    shimmerCenter - shimmerWidth,
                    0,
                    shimmerCenter + shimmerWidth,
                    0,
                );
                grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
                grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.30)');
                grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
                ctx2d.fillStyle = grad;
                ctx2d.fillRect(0, 0, w, h);
                ctx2d.restore();
            }

            // Pass 5: unplayed dim mask. Use a 24-pixel transition centered
            // on the playhead so the played/unplayed boundary is soft, not a
            // hard edge.
            ctx2d.save();
            ctx2d.globalCompositeOperation = 'destination-in';
            const dimGrad = ctx2d.createLinearGradient(playheadX, 0, playheadX + 24, 0);
            dimGrad.addColorStop(0, 'rgba(0,0,0,1)');
            dimGrad.addColorStop(1, 'rgba(0,0,0,0.40)');
            ctx2d.fillStyle = dimGrad;
            ctx2d.fillRect(0, 0, w, h);
            ctx2d.restore();

            // Pass 6: playhead glow strip.
            if (!reducedMotion && glowFactor > 0) {
                ctx2d.save();
                ctx2d.globalCompositeOperation = 'source-over';
                ctx2d.fillStyle = accent;
                ctx2d.globalAlpha = 0.28 * glowFactor;
                ctx2d.shadowColor = accent;
                ctx2d.shadowBlur = 6 * glowFactor;
                ctx2d.fillRect(playheadX - 2, 0, 4, h);
                ctx2d.restore();
            }

            // Continue the chain while animating.
            if (isAnimating) {
                rafId = requestAnimationFrame(draw);
            }
        };

        const schedule = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(draw);
        };
        // Expose to the resize observer so a resize-driven canvas clear
        // triggers a redraw even while playback is paused.
        scheduleDrawRef.current = schedule;

        // Initial paint. While playing, this also seeds the continuous rAF
        // chain (draw() re-arms itself).
        schedule();

        // Keep the playhead position fresh even when paused — `setTimestamp`
        // is also fired on seek, so a user scrubbing while paused should see
        // the playhead glide along. While playing, the running rAF loop will
        // pick up the new `lastPlayheadMs` on its next tick; calling
        // schedule() here is a no-op (rafId is already set).
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
