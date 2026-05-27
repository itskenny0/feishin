import {
    DispatcherDeps,
    dispatchJellyfinMessage,
} from '/@/renderer/features/jellyfin-remote-control/controller/message-dispatcher';
import { JellyfinIncomingMessage } from '/@/renderer/features/jellyfin-remote-control/types';

const KEEPALIVE_INTERVAL_MS = 30_000;
// Capped at the longest backoff (30s) after RECONNECT_BACKOFF_MS.length - 1
// attempts. We then keep retrying at the cap forever — but only after a
// successful socket-open that lasted at least MIN_SUCCESS_UPTIME_MS resets
// the attempt counter to 0, so a server that comes back online recovers
// quickly. See scheduleReconnect.
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const MAX_RECONNECT_ATTEMPTS = 30;
const MIN_SUCCESS_UPTIME_MS = 60_000;
// Cap incoming WS frames so a misbehaving (or malicious) server can't OOM
// the renderer by sending arbitrarily large messages. 1 MiB is generous —
// real Jellyfin messages are <10 KiB.
const MAX_INCOMING_MESSAGE_BYTES = 1_048_576;

// Production logs were leaking the user's Jellyfin auth token via the WS URL
// (api_key= query param) and every incoming command payload. Gated behind a
// dev flag so the receiver can still be debugged when something breaks.
const DEBUG =
    typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV;

const debug = (...args: unknown[]) => {
    if (DEBUG) console.log('[jellyfin-remote]', ...args);
};

// Always-on lifecycle breadcrumbs so "Feishin won't connect / isn't
// controllable" reports are diagnosable in the field. Never log tokens or
// command payloads here — those stay behind the DEBUG gate via `debug`.
const info = (...args: unknown[]) => console.info('[jellyfin-remote]', ...args);

/**
 * Strip the query string from a URL before logging. Jellyfin's WS handshake
 * URL includes the user's api_key — we never want that in DevTools, log
 * files, or crash collectors.
 */
const safeUrl = (raw: string): string => {
    const i = raw.indexOf('?');
    return i === -1 ? raw : `${raw.slice(0, i)}?<redacted>`;
};

export interface ControllerStartArgs {
    authHeader: string;
    capabilitiesPayload: unknown;
    client: string; // e.g. "Feishin"
    device: string; // e.g. "Desktop Client"
    deviceId: string;
    dispatcherDeps: DispatcherDeps;
    serverUrl: string;
    token: string;
    version: string; // e.g. "1.11.0"
}

export class JellyfinRemoteController {
    private attempt = 0;
    private capabilitiesSent = false;
    /**
     * Bumped on every start()/stop() so async work from a previous lifecycle
     * (capabilities POST, scheduled reconnect, WS event handler) can detect
     * that it has been superseded and bail out. Without this, a server switch
     * during an in-flight capabilities POST would leak the previous lifecycle's
     * socket and dispatch incoming messages with stale dispatcherDeps.
     */
    private generation = 0;
    private isStopped = true;
    private keepaliveTimer: null | ReturnType<typeof setInterval> = null;
    private lastSocketOpenedAt = 0;
    private reconnectTimer: null | ReturnType<typeof setTimeout> = null;
    private startArgs: ControllerStartArgs | null = null;
    private ws: null | WebSocket = null;

    async start(args: ControllerStartArgs): Promise<void> {
        this.stop();
        this.generation += 1;
        const gen = this.generation;
        this.isStopped = false;
        this.startArgs = args;
        this.attempt = 0;
        this.capabilitiesSent = false;

        await this.postCapabilities(gen);
        if (this.generation !== gen || this.isStopped) return;
        this.openSocket(gen);
    }

    stop(): void {
        // Invalidate any pending awaits / scheduled work.
        this.generation += 1;
        this.isStopped = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
        if (this.ws) {
            try {
                this.ws.onopen = null;
                this.ws.onmessage = null;
                this.ws.onerror = null;
                this.ws.onclose = null;
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    private buildSocketUrl(args: ControllerStartArgs): string {
        const httpUrl = new URL(args.serverUrl);
        const wsScheme = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        const path = httpUrl.pathname.replace(/\/$/, '') + '/socket';
        const params = new URLSearchParams({
            api_key: args.token,
            client: args.client,
            device: args.device,
            deviceId: args.deviceId,
            version: args.version,
        });
        return `${wsScheme}//${httpUrl.host}${path}?${params.toString()}`;
    }

    private openSocket(gen: number): void {
        if (this.generation !== gen || !this.startArgs || this.isStopped) return;
        const args = this.startArgs;
        const url = this.buildSocketUrl(args);

        let socket: WebSocket;
        try {
            socket = new WebSocket(url);
        } catch (err) {
            console.warn('[jellyfin-remote] WebSocket constructor failed', err);
            this.scheduleReconnect(gen);
            return;
        }
        this.ws = socket;

        debug('opening socket', safeUrl(url));

        socket.onopen = () => {
            if (this.generation !== gen) {
                // Late open from a superseded lifecycle — close immediately
                // so we don't process its messages.
                try {
                    socket.close();
                } catch {
                    // ignore
                }
                return;
            }
            info('socket open');
            this.lastSocketOpenedAt = Date.now();
            this.attempt = 0;
            if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify({ MessageType: 'KeepAlive' }));
                }
            }, KEEPALIVE_INTERVAL_MS);
        };

        socket.onmessage = (event) => {
            if (this.generation !== gen) return;
            const raw = typeof event.data === 'string' ? event.data : '';
            if (raw.length === 0 || raw.length > MAX_INCOMING_MESSAGE_BYTES) return;
            let parsed: JellyfinIncomingMessage;
            try {
                parsed = JSON.parse(raw);
            } catch {
                return;
            }
            if (!parsed || typeof parsed.MessageType !== 'string') return;
            if (parsed.MessageType !== 'KeepAlive' && parsed.MessageType !== 'ForceKeepAlive') {
                debug('received', parsed.MessageType);
            }
            // Read dispatcherDeps fresh each call rather than from the
            // captured `args` so a setting change applied via start() with a
            // new generation never reaches a stale dispatcher.
            const currentArgs = this.startArgs;
            if (!currentArgs) return;
            dispatchJellyfinMessage(parsed, currentArgs.dispatcherDeps).catch((err) => {
                console.error('[jellyfin-remote] dispatch failed', err);
            });
        };

        socket.onerror = () => {
            // The WebSocket spec's `error` event carries no useful detail —
            // close codes / reasons arrive on `onclose` instead. Log a
            // breadcrumb only.
            debug('socket error event');
        };

        socket.onclose = (event) => {
            if (this.generation !== gen) return;
            info('socket closed', { code: event.code, wasClean: event.wasClean });
            if (this.keepaliveTimer) {
                clearInterval(this.keepaliveTimer);
                this.keepaliveTimer = null;
            }
            this.ws = null;
            // Sustained uptime resets the backoff so a server returning from
            // a long outage doesn't get stuck at the 30s cap forever.
            if (Date.now() - this.lastSocketOpenedAt > MIN_SUCCESS_UPTIME_MS) {
                this.attempt = 0;
            }
            if (!this.isStopped) this.scheduleReconnect(gen);
        };
    }

    private async postCapabilities(gen: number): Promise<void> {
        if (this.generation !== gen || !this.startArgs) return;
        const args = this.startArgs;
        const url = `${args.serverUrl}/Sessions/Capabilities/Full`;
        try {
            const res = await fetch(url, {
                body: JSON.stringify(args.capabilitiesPayload),
                headers: {
                    Authorization: args.authHeader,
                    'Content-Type': 'application/json',
                },
                method: 'POST',
            });
            if (this.generation !== gen) return;
            info('capabilities registered', { status: res.status });
            if (res.status === 401) {
                console.warn(
                    '[jellyfin-remote] capabilities POST: 401 — disabling for this credential',
                );
                this.isStopped = true;
                return;
            }
            if (res.ok || res.status === 204) {
                this.capabilitiesSent = true;
            } else {
                // Leave capabilitiesSent=false so the next reconnect retries it.
                console.warn(
                    `[jellyfin-remote] capabilities POST returned ${res.status}; will retry`,
                );
            }
        } catch (err) {
            // Network blip — leave capabilitiesSent=false so the next reconnect retries.
            console.warn('[jellyfin-remote] capabilities POST threw', err);
        }
    }

    private scheduleReconnect(gen: number): void {
        if (this.generation !== gen || this.isStopped) return;
        if (this.reconnectTimer) return;
        if (this.attempt >= MAX_RECONNECT_ATTEMPTS) {
            // Give up on this lifecycle to avoid endless background traffic
            // against an unreachable / mis-configured server. The next
            // explicit start() call (server switch, settings toggle) starts
            // a fresh lifecycle and resets the counter.
            console.warn(
                `[jellyfin-remote] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`,
            );
            this.isStopped = true;
            return;
        }
        const delay = RECONNECT_BACKOFF_MS[Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)];
        this.attempt += 1;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.generation !== gen || this.isStopped) return;
            if (!this.capabilitiesSent) {
                await this.postCapabilities(gen);
                if (this.generation !== gen || this.isStopped) return;
            }
            this.openSocket(gen);
        }, delay);
    }
}
