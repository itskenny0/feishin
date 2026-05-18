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

/**
 * Draws the glow-wave trackmap. Subscribes to:
 *  - useTrackmap(currentSong) for the bins.
 *  - The timestamp store for the playhead position (without re-rendering React).
 *  - ResizeObserver on the wrapper for device-pixel-ratio handling.
 *  - prefers-reduced-motion to disable the halo pass.
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
            // timestamp tick (matters when paused).
            scheduleDrawRef.current?.();
        };

        sync();
        const ro = new ResizeObserver(sync);
        ro.observe(container);
        return () => ro.disconnect();
    }, []);

    // Draw loop — subscribes to the timestamp store directly.
    useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;

        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return;

        const reducedMotion =
            typeof window !== 'undefined' &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        let lastPlayheadMs = 0;
        let rafId: null | number = null;
        let unsub: (() => void) | null = null;

        const draw = () => {
            rafId = null;
            const w = canvas.width;
            const h = canvas.height;
            ctx2d.clearRect(0, 0, w, h);

            const trackmap = dataRef.current;
            if (!trackmap || styleRef.current !== 'glow') return;

            const accent = readAccentColor();
            const heightFactor = heightRef.current / 100;
            const glowFactor = glowRef.current / 100;
            const actualHeight = h * heightFactor;
            const yBase = h;
            const yTop = h - actualHeight;

            const bins = trackmap.bins;
            const binCount = bins.length;

            const pts: Array<[number, number]> = [];
            for (let i = 0; i < binCount; i += 1) {
                const x = (i / (binCount - 1)) * w;
                const y = yBase - bins[i] * actualHeight;
                pts.push([x, y]);
            }

            const drawPath = () => {
                ctx2d.beginPath();
                ctx2d.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i += 1) {
                    ctx2d.lineTo(pts[i][0], pts[i][1]);
                }
            };

            // Pass 1: halo (skipped under prefers-reduced-motion).
            if (!reducedMotion && glowFactor > 0) {
                ctx2d.save();
                ctx2d.strokeStyle = accent;
                ctx2d.lineWidth = 2;
                ctx2d.globalAlpha = 0.6 * glowFactor;
                ctx2d.shadowColor = accent;
                ctx2d.shadowBlur = 16 * glowFactor;
                drawPath();
                ctx2d.stroke();
                ctx2d.restore();
            }

            // Pass 2: crisp line.
            ctx2d.save();
            ctx2d.strokeStyle = accent;
            ctx2d.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.5);
            ctx2d.globalAlpha = 1;
            ctx2d.shadowBlur = 0;
            drawPath();
            ctx2d.stroke();
            ctx2d.restore();

            // Pass 3: unplayed dim mask.
            const playheadFrac =
                trackmap.durationMs > 0
                    ? Math.min(1, Math.max(0, lastPlayheadMs / trackmap.durationMs))
                    : 0;
            const playheadX = playheadFrac * w;

            ctx2d.save();
            ctx2d.globalCompositeOperation = 'destination-in';
            const gradient = ctx2d.createLinearGradient(playheadX, 0, playheadX + 24, 0);
            gradient.addColorStop(0, 'rgba(0,0,0,1)');
            gradient.addColorStop(1, 'rgba(0,0,0,0.40)');
            ctx2d.fillStyle = gradient;
            ctx2d.fillRect(0, 0, w, h);
            ctx2d.restore();

            // Pass 4: playhead glow strip.
            if (!reducedMotion && glowFactor > 0) {
                ctx2d.save();
                ctx2d.fillStyle = accent;
                ctx2d.globalAlpha = 0.2 * glowFactor;
                ctx2d.shadowColor = accent;
                ctx2d.shadowBlur = 6 * glowFactor;
                ctx2d.fillRect(playheadX - 2, yTop, 4, actualHeight);
                ctx2d.restore();
            }
        };

        const schedule = () => {
            if (rafId !== null) return;
            rafId = requestAnimationFrame(draw);
        };
        // Expose to the resize observer so a resize-driven canvas clear
        // triggers a redraw even while playback is paused.
        scheduleDrawRef.current = schedule;

        schedule();

        if (playerStatus === PlayerStatus.PLAYING) {
            unsub = subscribePlayerProgress(({ timestamp }) => {
                lastPlayheadMs = timestamp * 1000;
                schedule();
            });
        }

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
