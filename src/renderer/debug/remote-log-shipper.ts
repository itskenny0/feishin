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

// ── Crash-surviving ring buffer ─────────────────────────────────────────────
// The headline crash happens while the device is OFFLINE (airplane mode), so
// nothing can ship live. Every entry is also mirrored into a localStorage
// ring — synchronous writes survive a process kill — and on the next launch
// any leftover ring from a PREVIOUS session uploads as backlog (retrying
// until the receiver acks), so the final pre-crash heartbeats and logs arrive
// once the device is back online.
const RING_KEY = 'remote_debug_ring';
// String-append ring: entries are NDJSON lines in one string, persisted with
// a single setItem per entry (write-through — the crash kills the renderer
// with no JS error, so the last synchronous write IS the evidence horizon).
// Trimmed from the front when over budget.
const RING_MAX_CHARS = 400_000;
const BACKLOG_RETRY_MS = 30_000;

let ringStr = '';
let backlogRetryTimer: null | ReturnType<typeof setInterval> = null;

const persistRing = (): void => {
    try {
        localStorage.setItem(RING_KEY, ringStr);
    } catch {
        // Quota/serialization failures must never break the app.
    }
};

const recordToRing = (entry: ShipperEntry): void => {
    ringStr += `${JSON.stringify(entry)}\n`;
    if (ringStr.length > RING_MAX_CHARS) {
        // Drop the oldest ~25%, cutting at a line boundary.
        const cut = ringStr.indexOf('\n', Math.floor(RING_MAX_CHARS / 4));
        ringStr = cut >= 0 ? ringStr.slice(cut + 1) : '';
    }
    persistRing();
};

const parseRing = (raw: null | string): ShipperEntry[] => {
    if (!raw) return [];
    // Current string-NDJSON format; tolerate the earlier JSON-array format.
    try {
        if (raw.startsWith('[')) return JSON.parse(raw) as ShipperEntry[];
    } catch {
        return [];
    }
    return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try {
                return JSON.parse(line) as ShipperEntry;
            } catch {
                return null;
            }
        })
        .filter((e): e is ShipperEntry => e !== null);
};

const shipBacklog = (): void => {
    if (!endpointUrl) return;
    let leftover: ShipperEntry[] = [];
    try {
        leftover = parseRing(localStorage.getItem(RING_KEY));
    } catch {
        leftover = [];
    }
    // Only a PREVIOUS session's ring is backlog; the current session's ring
    // is the live mirror of what's already being shipped.
    const backlog = leftover.filter((e) => e && e.session !== session);
    if (backlog.length === 0) {
        if (backlogRetryTimer) {
            clearInterval(backlogRetryTimer);
            backlogRetryTimer = null;
        }
        return;
    }
    // Chunked, NON-keepalive POSTs: fetch keepalive rejects bodies >64KB,
    // which silently dropped every backlog from the write-through ring
    // (~400KB) — the crash evidence never left the device. Backlog runs in a
    // live page, so keepalive isn't needed; chunking keeps each POST modest.
    const CHUNK_BYTES = 48_000;
    const chunks: string[] = [];
    let current = '';
    for (const e of backlog) {
        const line = `${JSON.stringify({ ...e, backlog: true })}\n`;
        if (current.length + line.length > CHUNK_BYTES && current) {
            chunks.push(current);
            current = '';
        }
        current += line;
    }
    if (current) chunks.push(current);

    void (async () => {
        try {
            for (const chunk of chunks) {
                const res = await fetch(endpointUrl!, {
                    body: chunk,
                    headers: { 'Content-Type': 'application/x-ndjson' },
                    method: 'POST',
                });
                if (!res.ok) return; // retry timer re-attempts from scratch
            }
            // All chunks acked — drop ONLY the previous-session entries;
            // keep the current session's mirror intact.
            const mine = parseRing(ringStr).filter((e) => e.session === session);
            ringStr = mine.map((e) => `${JSON.stringify(e)}\n`).join('');
            persistRing();
            if (backlogRetryTimer) {
                clearInterval(backlogRetryTimer);
                backlogRetryTimer = null;
            }
            console.info('[shipper] backlog delivered', {
                chunks: chunks.length,
                entries: backlog.length,
            });
        } catch {
            // retry timer will try again
        }
    })();
};

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
            // keepalive caps the body at 64KB and REJECTS above it — only
            // safe for small payloads.
            keepalive: body.length < 60_000,
            method: 'POST',
        }).catch(() => {});
    } catch {
        // diagnostics must never throw into the app
    }
};

const shipNow = (entry: ShipperEntry): void => {
    recordToRing(entry);
    post(JSON.stringify(entry));
};

const enqueue = (entry: ShipperEntry): void => {
    recordToRing(entry);
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

    // Load any leftover ring from a previous (possibly crashed) session
    // BEFORE the first persist could overwrite it, then upload it as backlog
    // — retrying until the receiver acks, in case we boot still offline.
    try {
        const raw = localStorage.getItem(RING_KEY) ?? '';
        // Tolerate the earlier JSON-array format by re-encoding it.
        ringStr = raw.startsWith('[')
            ? parseRing(raw)
                  .map((e) => `${JSON.stringify(e)}\n`)
                  .join('')
            : raw;
    } catch {
        ringStr = '';
    }
    shipBacklog();
    backlogRetryTimer = setInterval(shipBacklog, BACKLOG_RETRY_MS);

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
    persistRing();
    if (backlogRetryTimer) {
        clearInterval(backlogRetryTimer);
        backlogRetryTimer = null;
    }
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

// The endpoint field writes through on every keystroke, and a naive apply()
// restarted the shipper per character — the receiver logged ~20 two-line
// sessions for one URL edit (observed 2026-06-11). Endpoint EDITS settle for
// a moment before reconnecting; flipping the enabled switch (and the
// boot-time apply) stays immediate.
const APPLY_DEBOUNCE_MS = 1500;
let applyTimer: null | ReturnType<typeof setTimeout> = null;
const cancelPendingApply = (): void => {
    if (applyTimer) {
        clearTimeout(applyTimer);
        applyTimer = null;
    }
};
const applyDebounced = (settings: { enabled: boolean; endpoint: string }): void => {
    cancelPendingApply();
    applyTimer = setTimeout(() => {
        applyTimer = null;
        apply(settings);
    }, APPLY_DEBOUNCE_MS);
};

let initialized = false;

/** Boot-time entry point. Idempotent; subscribes to the settings store. */
export const initRemoteLogShipper = (): void => {
    if (initialized) return;
    initialized = true;

    let prevApplied = useSettingsStore.getState().remoteDebug;
    apply(prevApplied);
    useSettingsStore.subscribe(
        (state) => state.remoteDebug,
        (remoteDebug) => {
            const enabledChanged = remoteDebug.enabled !== prevApplied.enabled;
            prevApplied = remoteDebug;
            if (enabledChanged) {
                cancelPendingApply();
                apply(remoteDebug);
            } else {
                applyDebounced(remoteDebug);
            }
        },
        {
            equalityFn: (a, b) => a.enabled === b.enabled && a.endpoint === b.endpoint,
        },
    );
};

/** Test seam: tear down and allow re-init. */
export const __resetRemoteLogShipperForTests = (): void => {
    // A pending debounced apply would otherwise outlive the reset and
    // re-start the shipper after teardown.
    cancelPendingApply();
    stop();
    initialized = false;
};
