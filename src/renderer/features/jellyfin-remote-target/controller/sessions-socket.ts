// src/renderer/features/jellyfin-remote-target/controller/sessions-socket.ts
//
// Jellyfin native push channel for the /Sessions stream.
//
// Why this exists: the polling lane (`sessions-poller.ts`) sets a floor on
// click → mirror latency equal to the active-window cadence (~400ms) plus
// receiver publication delay. Jellyfin's WebSocket pushes /Sessions on every
// PlayState change, dropping that floor to ~50ms on LAN.
//
// Wire format (stable across Jellyfin server versions):
//   ws[s]://<host>/socket?api_key=<token>&deviceId=<id>
//
// Outbound: { MessageType: 'SessionsStart', Data: '0,1500' }
//   Subscribes to /Sessions push every 1500ms heartbeat. The first arg is the
//   initial delay; the second is the period for the "no-change keepalive".
//   Per-event pushes (Sessions, PlaybackProgress, PlayState) are independent
//   of this cadence — they fire as soon as the server has new state.
//
// Inbound shapes:
//   { MessageType: 'Sessions', Data: <SessionRow[]> }   ← the main signal
//   { MessageType: 'KeepAlive' }                         ← server liveness
//   { MessageType: 'ForceKeepAlive', Data: <seconds> }   ← keepalive cadence
//
// This module owns the socket lifecycle. The hook owns when to start/stop it.

import type { ServerListItemWithCredential } from '/@/shared/types/domain-types';

import { useAuthStore } from '/@/renderer/store/auth.store';
import { getServerUrl } from '/@/renderer/utils/normalize-server-url';

export type SessionsFrameCallback = (rawSessions: unknown[]) => void;

export interface SessionsSocketOptions {
    /** Receives every `Sessions` frame's `Data` array. Pure side-effect-free. */
    onSessionsFrame: SessionsFrameCallback;
    /** Surface connection state transitions to the hook for poller gating. */
    onStateChange?: (state: SessionsSocketState) => void;
    /** The Jellyfin server (with credential + url) to connect to. */
    server: ServerListItemWithCredential;
}

export type SessionsSocketState = 'closed' | 'connected' | 'connecting' | 'reconnecting';

/** Initial reconnect delay; doubles up to MAX. */
const RECONNECT_BASE_MS = 1_000;
/** Cap on the exponential reconnect backoff. */
const RECONNECT_MAX_MS = 30_000;
/**
 * Server-side keepalive cadence (ms). Jellyfin docs spec 1500ms as a heartbeat
 * floor for the SessionsStart subscription. Push events fire independently.
 */
const SESSIONS_HEARTBEAT_MS = 1_500;
/**
 * If we don't see any inbound traffic (Sessions, KeepAlive, anything) for
 * this long, treat the socket as dead and reconnect. Jellyfin sends a
 * ForceKeepAlive cadence we honour, with this as a safety net.
 */
const LIVENESS_TIMEOUT_MS = 30_000;

/**
 * Compute exponential reconnect delay for a given attempt count (0-based)
 * with full jitter (50%-100% of the computed value). The jitter prevents
 * a fleet of clients reconnecting on the same deterministic schedule after
 * a server hiccup, which would otherwise thunder-herd the /socket endpoint.
 *
 * attempt 0 → 0.5..1s, 1 → 1..2s, 2 → 2..4s, ..., 5+ → 15..30s.
 *
 * Exported for unit tests; the `rng` arg lets tests seed Math.random.
 */
export const reconnectDelayMs = (attempt: number, rng: () => number = Math.random): number => {
    const base = attempt <= 0 ? RECONNECT_BASE_MS : RECONNECT_BASE_MS * 2 ** attempt;
    const ceiling = Math.min(base, RECONNECT_MAX_MS);
    return ceiling * (0.5 + rng() * 0.5);
};

/**
 * Translate the server's HTTP(S) base URL to a ws(s) socket URL with the
 * SignalR-style `/socket` path Jellyfin expects, plus auth + device id.
 */
export const buildSocketUrl = (
    server: ServerListItemWithCredential,
    deviceId: string,
): null | string => {
    const base = getServerUrl(server);
    if (!base) return null;
    let wsBase: string;
    try {
        const parsed = new URL(base);
        parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
        // Strip trailing slash on path so we don't double up before /socket.
        parsed.pathname = parsed.pathname.replace(/\/$/, '') + '/socket';
        parsed.search = '';
        wsBase = parsed.toString();
    } catch {
        return null;
    }
    const params = new URLSearchParams({
        api_key: server.credential,
        deviceId,
    });
    return `${wsBase}?${params.toString()}`;
};

/** Narrow check: was the message a valid Jellyfin WS envelope? */
const parseEnvelope = (data: unknown): null | { Data?: unknown; MessageType: string } => {
    if (typeof data !== 'string') return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(data);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;
    const msg = parsed as { Data?: unknown; MessageType?: unknown };
    if (typeof msg.MessageType !== 'string') return null;
    return { Data: msg.Data, MessageType: msg.MessageType };
};

/**
 * Extract a session-row array from a `Sessions` frame's Data field. Jellyfin
 * always wraps the rows in an array, but defend against bare objects / nulls
 * landing here from custom forks or proxies.
 */
const extractSessionRows = (data: unknown): unknown[] => {
    if (Array.isArray(data)) return data;
    return [];
};

/**
 * Owns one Jellyfin WebSocket connection. The hook is responsible for
 * constructing and stopping instances; this class never holds module-level
 * state so unit tests can spin up isolated copies.
 *
 * Lifecycle logging is always-on (per repo convention) and tagged
 * `[remote-target]` so it surfaces in DevTools without a debug flag.
 */
export class SessionsSocket {
    private livenessTimer: null | ReturnType<typeof setTimeout> = null;

    private reconnectAttempt = 0;
    private reconnectTimer: null | ReturnType<typeof setTimeout> = null;
    private socket: null | WebSocket = null;
    private state: SessionsSocketState = 'closed';
    private stopped = false;

    constructor(private readonly options: SessionsSocketOptions) {}

    /** Test seam: surface the current state without exposing the socket. */
    getState(): SessionsSocketState {
        return this.state;
    }

    /** Open the WebSocket and subscribe to the /Sessions push channel. */
    start(): void {
        if (this.socket || this.reconnectTimer) return;
        this.stopped = false;
        this.reconnectAttempt = 0;
        this.connect();
    }

    /** Close the WebSocket and cancel any pending reconnect. */
    stop(): void {
        this.stopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.livenessTimer) {
            clearTimeout(this.livenessTimer);
            this.livenessTimer = null;
        }
        const sock = this.socket;
        this.socket = null;
        if (sock) {
            try {
                // Best-effort unsubscribe so the server stops queueing
                // Sessions frames for a deviceId that's about to disappear.
                if (sock.readyState === WebSocket.OPEN) {
                    sock.send(JSON.stringify({ Data: '', MessageType: 'SessionsStop' }));
                }
                sock.close();
            } catch {
                // ignored — close() can throw on already-closed sockets
            }
        }
        this.setState('closed');
    }

    private armLiveness(): void {
        if (this.livenessTimer) clearTimeout(this.livenessTimer);
        this.livenessTimer = setTimeout(() => {
            console.warn('[remote-target] socket liveness timeout — forcing reconnect');
            this.forceReconnect();
        }, LIVENESS_TIMEOUT_MS);
    }

    private connect(): void {
        if (this.stopped) return;
        const { server } = this.options;
        const deviceId = useAuthStore.getState().deviceId;
        const url = buildSocketUrl(server, deviceId);
        if (!url) {
            console.warn('[remote-target] socket build-url failed', { serverUrl: server.url });
            return;
        }
        this.setState(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting');

        let sock: WebSocket;
        try {
            sock = new WebSocket(url);
        } catch (err) {
            console.warn('[remote-target] socket construct failed', err);
            this.scheduleReconnect();
            return;
        }
        this.socket = sock;

        sock.onopen = () => {
            console.info('[remote-target] socket open', { attempt: this.reconnectAttempt });
            this.reconnectAttempt = 0;
            this.setState('connected');
            this.armLiveness();
            try {
                // SessionsStart args: '<initialDelayMs>,<periodMs>'. We use
                // 0 initial so the first snapshot lands immediately.
                sock.send(
                    JSON.stringify({
                        Data: `0,${SESSIONS_HEARTBEAT_MS}`,
                        MessageType: 'SessionsStart',
                    }),
                );
            } catch (err) {
                console.warn('[remote-target] socket subscribe send failed', err);
            }
        };

        sock.onmessage = (ev) => this.handleMessage(ev.data);

        sock.onerror = (ev) => {
            // The browser doesn't expose any detail on `Event`; log shape only.
            console.warn('[remote-target] socket error', { type: ev.type });
        };

        sock.onclose = (ev) => {
            console.info('[remote-target] socket close', {
                code: ev.code,
                reason: ev.reason,
                wasClean: ev.wasClean,
            });
            this.socket = null;
            if (this.livenessTimer) {
                clearTimeout(this.livenessTimer);
                this.livenessTimer = null;
            }
            if (this.stopped) {
                this.setState('closed');
                return;
            }
            this.scheduleReconnect();
        };
    }

    private forceReconnect(): void {
        const sock = this.socket;
        this.socket = null;
        if (sock) {
            try {
                sock.close();
            } catch {
                // ignored
            }
        }
        if (!this.stopped) this.scheduleReconnect();
    }

    private handleMessage(data: unknown): void {
        this.armLiveness();
        const envelope = parseEnvelope(data);
        if (!envelope) return;
        switch (envelope.MessageType) {
            case 'ForceKeepAlive': {
                // Server-suggested keepalive cadence in seconds. We don't have
                // anything to keep alive (no ping/pong needed for browser WS),
                // but logging makes mismatches easier to debug.
                console.info('[remote-target] socket keepalive-cadence', {
                    seconds: envelope.Data,
                });
                return;
            }
            case 'KeepAlive':
                return;
            case 'Sessions': {
                const rows = extractSessionRows(envelope.Data);
                console.info('[remote-target] socket sessions-frame', { count: rows.length });
                try {
                    this.options.onSessionsFrame(rows);
                } catch (err) {
                    console.warn('[remote-target] sessions-frame handler threw', err);
                }
                return;
            }
            default:
                // Other frames (PlaybackProgress, PlayState, GeneralCommand)
                // are server-→-client control envelopes addressed to *this*
                // device, not to the receiver we're driving. We don't react
                // to them in the controller; the receiver implementation
                // owns its own socket if/when we run as a receiver.
                return;
        }
    }

    private scheduleReconnect(): void {
        if (this.stopped) return;
        if (this.reconnectTimer) return;
        const delay = reconnectDelayMs(this.reconnectAttempt);
        console.info('[remote-target] socket reconnect', {
            attempt: this.reconnectAttempt,
            delayMs: delay,
        });
        this.setState('reconnecting');
        this.reconnectAttempt += 1;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    private setState(next: SessionsSocketState): void {
        if (this.state === next) return;
        this.state = next;
        try {
            this.options.onStateChange?.(next);
        } catch (err) {
            console.warn('[remote-target] socket onStateChange threw', err);
        }
    }
}
