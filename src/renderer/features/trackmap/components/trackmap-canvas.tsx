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

/** Strand B — committed cyberpunk-pink. Fixed, not theme-derived. */
const STRAND_B: Rgb = { b: 182, g: 114, r: 244 }; // #f472b6 (Tailwind pink-400)
/** Background ribbon glow — deep violet. */
const BG_GLOW = 'rgba(124, 58, 237'; // #7c3aed (Tailwind violet-600), alpha appended
/** Cool / "slow" anchor for the envelope-fill energy gradient. */
const COOL_COLOR: Rgb = { b: 246, g: 89, r: 155 }; // ≈ #9b59f6 — soft purple

const rgbStr = (c: Rgb, a?: number): string =>
    a === undefined ? `rgb(${c.r}, ${c.g}, ${c.b})` : `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;

/**
 * Build a horizontal gradient whose color at each bin position interpolates
 * between the cool anchor (low intensity) and the theme accent (high
 * intensity) using `bins[i]` as the weight. Used by the envelope-fill pass
 * so the silhouette reads the song's mood spatially.
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
 * Draws a double-helix "data tape" behind the seek slider. The intensity
 * bins control the envelope (how far each strand swings from the centerline);
 * the helix itself contributes the smooth sinusoidal motion across x. Two
 * strands intertwine with phase offset π, and additive blending where they
 * cross produces bright flashes without any explicit crossover scripting.
 * Thin "base-pair" rungs connect the strands every ~22 px for DNA character.
 *
 * Motion (skipped under prefers-reduced-motion):
 *  - Helix rotation: one full twist every ~6 s
 *  - Spatial drift: pattern slides rightward (~6 s per canvas width)
 *  - Breath: amplitude ±3% over 7 s
 *
 * The animation loop runs continuously while playing so every frame is
 * driven by `performance.now()` rather than the once-per-second timestamp
 * subscription — that's what makes it look smooth instead of blocky.
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
    // Song duration (ms) read into a ref so the draw loop can compute the
    // playhead fraction against the *player engine's* timeline rather than
    // the decoded trackmap's duration. If a Jellyfin/Subsonic stream is
    // transcoded to a slightly different duration than the source metadata,
    // the two diverge by a few seconds and the visualisation visibly leads
    // (or lags) the audio. The audio engine sets `currentTime` against the
    // source duration, so we have to match that.
    const songDurationMsRef = useRef<number>(0);
    const scheduleDrawRef = useRef<(() => void) | null>(null);

    heightRef.current = height;
    glowRef.current = glow;
    dataRef.current = data;
    styleRef.current = style;
    songDurationMsRef.current = currentSong?.duration ?? 0;

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
            scheduleDrawRef.current?.();
        };

        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(container);

        // Also catch device-pixel-ratio changes that don't change the CSS
        // size (e.g. user drags the window to a Retina monitor). Without
        // this, the canvas backing store stays at the old DPR and renders
        // blurry. We watch a matchMedia query pinned to the current DPR;
        // when it stops matching, DPR has changed — sync and re-arm.
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

    // Continuous draw loop while playing — every frame is a `performance.now()`
    // sample, so the helix rotation / drift / breath all advance at 60 fps.
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
            // Defensive: trackmap must exist, the style must match, AND the
            // bins must have content. A zero-length bins array would make
            // `binCount - 1 = -1` and produce NaN coordinates downstream.
            if (
                !trackmap ||
                styleRef.current !== 'glow' ||
                !trackmap.bins ||
                trackmap.bins.length < 2
            ) {
                if (isAnimating) rafId = requestAnimationFrame(draw);
                return;
            }

            const accent = readAccentColor();
            const strandA = parseColor(accent) ?? { b: 238, g: 211, r: 34 }; // #22d3ee fallback
            const heightFactor = heightRef.current / 100;
            const glowFactor = glowRef.current / 100;
            const dpr = window.devicePixelRatio || 1;

            const now = isAnimating ? performance.now() : 0;
            const yCenter = h / 2;
            const baseHalfH = (h / 2) * heightFactor;
            // Subtle breath: ±3% over 7s. Always positive so the helix never inverts.
            const breath = 1 + 0.03 * Math.sin((now / 7000) * Math.PI * 2);
            const halfH = baseHalfH * breath;

            // Helix parameters. The rotation has been slowed since the user
            // reported the previous rightward drift was smearing the spatial
            // information — the eye couldn't latch onto "where in the song
            // we are now" because the helix kept shifting. Combined with
            // the envelope-fill pass above (which provides a stable amplitude
            // silhouette regardless of helix phase), this slow rotation now
            // reads as ambient motion rather than disorienting flow.
            const helixCycles = 6; // how many full twists span the canvas width
            const helixOmega = (Math.PI * 2) / 14000; // rad/ms, one rotation per 14 s
            const rot = now * helixOmega;

            const bins = trackmap.bins;
            const binCount = bins.length;

            // Sub-pixel bin interpolation — feeds the polyline at one sample
            // per device pixel so the strands look continuous, not stair-stepped.
            const sampleBin = (xFrac: number): number => {
                const f = xFrac * (binCount - 1);
                const lo = Math.floor(f);
                const hi = Math.min(binCount - 1, lo + 1);
                const t = f - lo;
                return bins[lo] * (1 - t) + bins[hi] * t;
            };

            // Phase at a given x. The `-rot` term makes the spatial pattern
            // drift rightward over time (positive cos-phase moves right as t
            // increases), matching the direction the playhead moves.
            const phaseAt = (xFrac: number): number => xFrac * Math.PI * 2 * helixCycles - rot;

            // Prefer the song-metadata duration (what the player engine
            // uses for `currentTime`) over the trackmap's decoded duration —
            // the two can disagree by several seconds for transcoded streams,
            // and using the wrong one makes the visualisation visibly lead
            // or lag the audio.
            const timelineMs =
                songDurationMsRef.current > 0 ? songDurationMsRef.current : trackmap.durationMs;
            const playheadFrac =
                timelineMs > 0 ? Math.min(1, Math.max(0, lastPlayheadMs / timelineMs)) : 0;
            const playheadX = playheadFrac * w;

            // === Pass 1: background ribbon glow ============================
            // A soft violet wash centered on the slider axis. Gives the
            // trackmap visible footprint even where the strands are quiet.
            {
                const bgGrad = ctx2d.createLinearGradient(0, yCenter - halfH, 0, yCenter + halfH);
                bgGrad.addColorStop(0, `${BG_GLOW}, 0)`);
                bgGrad.addColorStop(0.5, `${BG_GLOW}, 0.16)`);
                bgGrad.addColorStop(1, `${BG_GLOW}, 0)`);
                ctx2d.save();
                ctx2d.fillStyle = bgGrad;
                ctx2d.fillRect(0, 0, w, h);
                ctx2d.restore();
            }

            // === Pass 1.5: envelope-fill + outline silhouette ===============
            // The DATA layer — a clear mirrored wave shape filled with the
            // per-bin energy gradient (purple at quiet sections, theme accent
            // at peaks), AND stroked with a faint outline so the wave's
            // edge stays defined even where the helix sits low. Lets the
            // eye read amplitude at a glance: drops, choruses, bridges
            // all jump out as clear shapes regardless of helix phase.
            {
                const stepEnv = Math.max(1, Math.floor(dpr));
                const envGradient = buildEnergyGradient(ctx2d, w, bins, strandA);
                // Build the closed envelope path once and reuse it for fill + stroke.
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

                // Fill the area at modest opacity for visual mass.
                ctx2d.save();
                ctx2d.fillStyle = envGradient;
                ctx2d.globalAlpha = 0.3;
                ctx2d.fill();
                ctx2d.restore();

                // Stroke the outline at higher opacity so the wave edge
                // reads even when the fill is competing with the helix.
                ctx2d.save();
                ctx2d.strokeStyle = envGradient;
                ctx2d.globalAlpha = 0.65;
                ctx2d.lineWidth = Math.max(1, dpr);
                ctx2d.lineJoin = 'round';
                ctx2d.stroke();
                ctx2d.restore();
            }

            // === Pass 2: DNA base-pair rungs ================================
            // Thin vertical connectors between the two strands every ~22 px.
            // Opacity scales with |cos(phi)| so rungs fade out at crossings
            // (where the strands meet) and brighten at max separation.
            {
                const rungSpacingCssPx = 22;
                const rungSpacing = Math.max(2, rungSpacingCssPx * dpr);
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
                    ctx2d.strokeStyle = rgbStr(STRAND_B, 0.35 * visibility);
                    ctx2d.beginPath();
                    ctx2d.moveTo(xR, yA);
                    ctx2d.lineTo(xR, yB);
                    ctx2d.stroke();
                }
                ctx2d.restore();
            }

            // === Pass 3: strand halos (additive blend, blurred shadow) =====
            // The halo gives each strand its luminous "neon tube" appearance.
            // Additive blending means where the two halos overlap (at
            // crossings) they brighten to white — the natural cyberpunk glow.
            const step = Math.max(1, Math.floor(dpr)); // 1 CSS-pixel resolution
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

            if (!reducedMotion && glowFactor > 0) {
                ctx2d.save();
                ctx2d.globalCompositeOperation = 'lighter';
                ctx2d.lineCap = 'round';
                ctx2d.lineJoin = 'round';
                ctx2d.lineWidth = Math.max(2, 2.4 * dpr);
                ctx2d.shadowBlur = 14 * glowFactor;

                ctx2d.strokeStyle = rgbStr(strandA, 0.65 * glowFactor);
                ctx2d.shadowColor = rgbStr(strandA);
                drawStrandPath(-1);
                ctx2d.stroke();

                ctx2d.strokeStyle = rgbStr(STRAND_B, 0.65 * glowFactor);
                ctx2d.shadowColor = rgbStr(STRAND_B);
                drawStrandPath(1);
                ctx2d.stroke();

                ctx2d.restore();
            }

            // === Pass 4: crisp strands on top of the halos =================
            // Full-opacity lines, no shadow, still additive so crossings glow.
            ctx2d.save();
            ctx2d.globalCompositeOperation = 'lighter';
            ctx2d.lineCap = 'round';
            ctx2d.lineJoin = 'round';
            ctx2d.lineWidth = Math.max(1.5, 1.8 * dpr);
            ctx2d.shadowBlur = 0;

            ctx2d.strokeStyle = rgbStr(strandA, 0.9);
            drawStrandPath(-1);
            ctx2d.stroke();

            ctx2d.strokeStyle = rgbStr(STRAND_B, 0.9);
            drawStrandPath(1);
            ctx2d.stroke();

            ctx2d.restore();

            // === Pass 5: unplayed dim mask =================================
            // Middle ground — between the original 0.40 (too ignorable) and
            // the cyberpunk-max 0.55. Still clearly distinguishes played
            // from unplayed without either side disappearing.
            ctx2d.save();
            ctx2d.globalCompositeOperation = 'destination-in';
            const dimGrad = ctx2d.createLinearGradient(playheadX, 0, playheadX + 30, 0);
            dimGrad.addColorStop(0, 'rgba(0,0,0,1)');
            dimGrad.addColorStop(1, 'rgba(0,0,0,0.48)');
            ctx2d.fillStyle = dimGrad;
            ctx2d.fillRect(0, 0, w, h);
            ctx2d.restore();

            // === Pass 6: playhead glow strip ===============================
            // Bright vertical bar at the playhead. Additive blend so it
            // pops over the strands rather than masking them.
            if (!reducedMotion && glowFactor > 0) {
                ctx2d.save();
                ctx2d.globalCompositeOperation = 'lighter';
                ctx2d.fillStyle = rgbStr(strandA, 0.4 * glowFactor);
                ctx2d.shadowColor = rgbStr(strandA);
                ctx2d.shadowBlur = 12 * glowFactor;
                const phWidth = Math.max(2, 3 * dpr);
                ctx2d.fillRect(playheadX - phWidth / 2, 0, phWidth, h);
                ctx2d.restore();
            }

            // Chain the rAF while animating.
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
