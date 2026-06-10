// Remote debug log shipper.
//
// When `settings.remoteDebug.enabled` is on, the renderer streams its console
// output, uncaught errors, unhandled rejections and a 500ms heartbeat to a
// developer-controlled receiver over plain HTTP. Built to diagnose crashes
// that KILL the WebView (Android crash-to-launcher): local logs and devtools
// die with the process, so the only surviving evidence is whatever made it
// off the device first. Design consequences:
//
//  - error-class entries flush IMMEDIATELY (fetch keepalive), not batched;
//  - the heartbeat carries a monotonically increasing `seq` plus memory and
//    player-state snapshots — the receiver detects the death moment as the
//    point the sequence stops;
//  - pagehide/visibilitychange fire a final sendBeacon flush.
//
// The shipper is a module-level singleton driven by a settings subscription
// (initRemoteLogShipper is called once from app boot). All failures are
// swallowed — a diagnostics channel must never break the app it watches.

import { useSettingsStore } from '/@/renderer/store/settings.store';

const FLUSH_INTERVAL_MS = 300;
const HEARTBEAT_INTERVAL_MS = 500;
const MAX_QUEUE = 1000;
const MAX_MSG_CHARS = 4000;
const DEFAULT_PORT = 19191;

interface ConsolePatch {
    method: 'debug' | 'error' | 'info' | 'log' | 'warn';
    original: (...args: unknown[]) => void;
}

type ShipperEntry = {
    level?: string;
    mem?: unknown;
    msg?: string;
    player?: unknown;
    seq?: number;
    session: string;
    t: number;
    type: 'boot' | 'console' | 'error' | 'hb' | 'rejection';
};

let active = false;
let endpointUrl: null | string = null;
let session = '';
let queue: ShipperEntry[] = [];
let flushTimer: null | ReturnType<typeof setInterval> = null;
let heartbeatTimer: null | ReturnType<typeof setInterval> = null;
let heartbeatSeq = 0;
let consolePatches: ConsolePatch[] = [];
let listenersAttached = false;

/** `host`, `host:port`, or a full http(s) URL → POST target, or null. */
export const normalizeEndpoint = (raw: string): null | string => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) {
        return `${trimmed.replace(/\/+$/, '')}/log`;
    }
    // host or host:port
    const m = /^([a-zA-Z0-9_.-]+)(?::(\d{1,5}))?$/.exec(trimmed);
    if (!m) return null;
    const port = m[2] ? Number(m[2]) : DEFAULT_PORT;
    return `http://${m[1]}:${port}/log`;
};

const truncate = (s: string): string =>
    s.length > MAX_MSG_CHARS ? `${s.slice(0, MAX_MSG_CHARS)}…[truncated]` : s;

const stringifyArg = (arg: unknown): string => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ''}`;
    try {
        return JSON.stringify(arg);
    } catch {
        return String(arg);
    }
};

const post = (body: string, useBeacon = false): void => {
    if (!endpointUrl) return;
    try {
        if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
            navigator.sendBeacon(endpointUrl, body);
            return;
        }
        void fetch(endpointUrl, {
            body,
            headers: { 'Content-Type': 'application/x-ndjson' },
            keepalive: true,
            method: 'POST',
        }).catch(() => {});
    } catch {
        // diagnostics must never throw into the app
    }
};

const shipNow = (entry: ShipperEntry): void => {
    post(JSON.stringify(entry));
};

const enqueue = (entry: ShipperEntry): void => {
    if (queue.length >= MAX_QUEUE) queue.shift();
    queue.push(entry);
};

const flushQueue = (useBeacon = false): void => {
    if (queue.length === 0) return;
    const lines = queue.map((e) => JSON.stringify(e)).join('\n');
    queue = [];
    post(lines, useBeacon);
};

const makeEntry = (type: ShipperEntry['type'], extra: Partial<ShipperEntry>): ShipperEntry => ({
    session,
    t: Date.now(),
    type,
    ...extra,
});

const snapshotMemory = (): unknown => {
    const perf = performance as { memory?: { totalJSHeapSize: number; usedJSHeapSize: number } };
    if (!perf.memory) return undefined;
    return {
        totalMB: Math.round(perf.memory.totalJSHeapSize / 1048576),
        usedMB: Math.round(perf.memory.usedJSHeapSize / 1048576),
    };
};

const snapshotPlayer = (): unknown => {
    try {
        const audios = [...document.querySelectorAll('audio')].map((a) => ({
            err: a.error ? a.error.code : null,
            paused: a.paused,
            rs: a.readyState,
            src: a.currentSrc?.slice(0, 40),
        }));
        return { audios };
    } catch {
        return undefined;
    }
};

const onWindowError = (event: ErrorEvent): void => {
    shipNow(
        makeEntry('error', {
            level: 'error',
            msg: truncate(
                `${event.message} @ ${event.filename}:${event.lineno}\n${event.error?.stack ?? ''}`,
            ),
        }),
    );
    flushQueue();
};

const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
    shipNow(
        makeEntry('rejection', {
            level: 'error',
            msg: truncate(stringifyArg(event.reason)),
        }),
    );
    flushQueue();
};

const onPageHide = (): void => {
    enqueue(makeEntry('console', { level: 'info', msg: '[shipper] pagehide' }));
    flushQueue(true);
};

const onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
        flushQueue(true);
    }
};

const patchConsole = (): void => {
    const methods: ConsolePatch['method'][] = ['debug', 'error', 'info', 'log', 'warn'];
    for (const method of methods) {
        const original = console[method].bind(console) as ConsolePatch['original'];
        consolePatches.push({ method, original });
        console[method] = (...args: unknown[]) => {
            original(...args);
            try {
                const msg = truncate(args.map(stringifyArg).join(' '));
                const entry = makeEntry('console', { level: method, msg });
                if (method === 'error') {
                    shipNow(entry);
                } else {
                    enqueue(entry);
                }
            } catch {
                // never let diagnostics break console
            }
        };
    }
};

const unpatchConsole = (): void => {
    for (const { method, original } of consolePatches) {
        console[method] = original;
    }
    consolePatches = [];
};

const start = (endpoint: string): void => {
    const url = normalizeEndpoint(endpoint);
    if (!url) return;
    endpointUrl = url;
    session = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
    active = true;
    heartbeatSeq = 0;

    patchConsole();
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    listenersAttached = true;

    flushTimer = setInterval(() => flushQueue(), FLUSH_INTERVAL_MS);
    heartbeatTimer = setInterval(() => {
        heartbeatSeq += 1;
        // Heartbeats ship immediately (not batched): their arrival cadence IS
        // the signal; sitting in a batch would blur the death moment.
        shipNow(
            makeEntry('hb', {
                mem: snapshotMemory(),
                player: snapshotPlayer(),
                seq: heartbeatSeq,
            }),
        );
    }, HEARTBEAT_INTERVAL_MS);

    shipNow(
        makeEntry('boot', {
            level: 'info',
            msg: `[shipper] started — ${navigator.userAgent}`,
        }),
    );
    console.info('[shipper] remote debug log shipping ENABLED →', url);
};

const stop = (): void => {
    if (!active) return;
    active = false;
    flushQueue(true);
    unpatchConsole();
    if (listenersAttached) {
        window.removeEventListener('error', onWindowError);
        window.removeEventListener('unhandledrejection', onUnhandledRejection);
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        listenersAttached = false;
    }
    if (flushTimer) {
        clearInterval(flushTimer);
        flushTimer = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    endpointUrl = null;
};

const apply = (settings: { enabled: boolean; endpoint: string }): void => {
    if (settings.enabled && settings.endpoint.trim()) {
        // Restart on endpoint change while running.
        if (active) stop();
        start(settings.endpoint);
    } else {
        stop();
    }
};

let initialized = false;

/** Boot-time entry point. Idempotent; subscribes to the settings store. */
export const initRemoteLogShipper = (): void => {
    if (initialized) return;
    initialized = true;

    apply(useSettingsStore.getState().remoteDebug);
    useSettingsStore.subscribe(
        (state) => state.remoteDebug,
        (remoteDebug) => apply(remoteDebug),
        {
            equalityFn: (a, b) => a.enabled === b.enabled && a.endpoint === b.endpoint,
        },
    );
};

/** Test seam: tear down and allow re-init. */
export const __resetRemoteLogShipperForTests = (): void => {
    stop();
    initialized = false;
};
