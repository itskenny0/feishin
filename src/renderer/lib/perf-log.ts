// Lightweight, taggable performance logging. Emits `[perf] <event>` console
// lines (captured by the debug-log receiver) so slow surfaces can be diagnosed
// from logs without attaching a profiler. Zero behaviour change — pure logging.
//
// Disable at runtime with `localStorage.setItem('perfLog', 'off')`; re-enable by
// removing the key (or setting anything other than 'off'). The enabled flag is
// read once and cached so the hot paths (the global query observer, image
// resolves) pay only a boolean check.

import { useEffect, useRef } from 'react';

let cachedEnabled: boolean | undefined;

const isEnabled = (): boolean => {
    if (cachedEnabled === undefined) {
        try {
            cachedEnabled = localStorage.getItem('perfLog') !== 'off';
        } catch {
            cachedEnabled = true;
        }
    }
    return cachedEnabled;
};

export const perfNow = (): number => {
    try {
        return performance.now();
    } catch {
        return 0;
    }
};

export const perfLog = (event: string, data?: Record<string, unknown>): void => {
    if (!isEnabled()) return;
    try {
        if (data) {
            console.info(`[perf] ${event}`, data);
        } else {
            console.info(`[perf] ${event}`);
        }
    } catch {
        /* logging must never throw */
    }
};

// Start a span; call the returned fn to emit `[perf] <event>` with `ms` (plus
// any extra fields supplied at stop time). Returns the elapsed ms.
export const perfStart = (event: string, data?: Record<string, unknown>) => {
    const t0 = perfNow();
    return (extra?: Record<string, unknown>): number => {
        const ms = Math.round(perfNow() - t0);
        perfLog(event, { ...data, ...extra, ms });
        return ms;
    };
};

// Emit only when `ms` crosses `thresholdMs` — for hot paths where logging every
// call would flood (image resolves, per-row work).
export const perfLogSlow = (
    event: string,
    ms: number,
    thresholdMs: number,
    data?: Record<string, unknown>,
): void => {
    if (ms >= thresholdMs) perfLog(event, { ...data, ms: Math.round(ms) });
};

// Compact a react-query key into a readable `[perf]` label: the string segments
// plus a couple of identifying scalar fields from any filter object (so e.g.
// `[server, 'albumArtist', 'topSongs', {id, type}]` becomes
// `albumArtist/topSongs/id=…/type=personal`).
export const perfQueryKey = (key: unknown): string => {
    if (!Array.isArray(key)) return String(key);
    const parts: string[] = [];
    for (const p of key) {
        if (typeof p === 'string') {
            parts.push(p);
        } else if (p && typeof p === 'object') {
            for (const k of ['id', 'type', 'sortBy', 'searchTerm', 'artistIds']) {
                const v = (p as Record<string, unknown>)[k];
                if (typeof v === 'string' || typeof v === 'number') parts.push(`${k}=${v}`);
            }
        }
        if (parts.length >= 6) break;
    }
    return parts.join('/');
};

// Navigation timing: the layout marks each route change; route components log
// their settle time relative to the most recent nav.
let lastNavAt = perfNow();
let lastNavPath = '';

export const perfMarkNav = (path: string): void => {
    lastNavAt = perfNow();
    lastNavPath = path;
    perfLog('nav', { path });
};

// Log when a route's content first commits, measured from the last nav. `ready`
// lets a route defer the mark until its data has actually resolved (e.g. past a
// Suspense boundary) rather than firing for a skeleton.
export const usePerfRouteMount = (name: string, ready = true): void => {
    const logged = useRef(false);
    useEffect(() => {
        if (logged.current || !ready) return;
        logged.current = true;
        perfLog('route', { ms: Math.round(perfNow() - lastNavAt), name, path: lastNavPath });
    }, [name, ready]);
};
